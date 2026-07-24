#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createServer } from 'node:https';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const proxyRoot = '/var/lib/nyabase-e2e/agent-task-wire';
const configPath = `${proxyRoot}/config.json`;
const evidencePath = `${proxyRoot}/evidence.json`;
const releasePath = `${proxyRoot}/release`;
const certificatePath = `${proxyRoot}/edge.crt`;
const privateKeyPath = `${proxyRoot}/edge.key`;
const expectedTaskKind = 'image.ensure_present';
const maxPayloadBytes = 32 * 1024 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} has unknown or missing fields`,
  );
}

function validIso(value) {
  return value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

export function validateWireProxyConfig(value) {
  exactKeys(
    value,
    ['version', 'runId', 'nodeKey', 'mode', 'taskId', 'payloadHash', 'backendIp', 'listenPort'],
    'wire proxy config',
  );
  invariant(value.version === 1, 'wire proxy config version mismatch');
  invariant(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.runId),
    'wire proxy run identity is invalid',
  );
  invariant(
    value.nodeKey === 'node1' || value.nodeKey === 'node2',
    'wire proxy node identity is invalid',
  );
  invariant(
    value.mode === 'drop-terminal-once' ||
      value.mode === 'hold-terminal-until-release' ||
      value.mode === 'mutate-image-ref-once',
    'wire proxy mode is invalid',
  );
  invariant(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.taskId),
    'wire proxy task identity is invalid',
  );
  invariant(/^[a-f0-9]{64}$/.test(value.payloadHash), 'wire proxy payload hash is invalid');
  invariant(
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.backendIp),
    'wire proxy Backend address is invalid',
  );
  invariant(value.listenPort === 18443, 'wire proxy port is not provider-owned');
  return value;
}

export function createWireProxyEvidence(config) {
  return {
    version: 1,
    runId: config.runId,
    nodeKey: config.nodeKey,
    mode: config.mode,
    taskId: config.taskId,
    payloadHash: config.payloadHash,
    executeCount: 0,
    terminalCount: 0,
    droppedCount: 0,
    mutatedCount: 0,
    forwardedTerminalCount: 0,
    firstExecuteAt: null,
    lastExecuteAt: null,
    firstTerminalAt: null,
    lastForwardedTerminalAt: null,
  };
}

export function validateWireProxyEvidence(value, config) {
  exactKeys(value, Object.keys(createWireProxyEvidence(config)), 'wire proxy evidence');
  invariant(value.version === 1, 'wire proxy evidence version mismatch');
  for (const key of ['runId', 'nodeKey', 'mode', 'taskId', 'payloadHash']) {
    invariant(value[key] === config[key], `wire proxy evidence ${key} mismatch`);
  }
  for (const key of [
    'executeCount',
    'terminalCount',
    'droppedCount',
    'mutatedCount',
    'forwardedTerminalCount',
  ]) {
    invariant(
      Number.isSafeInteger(value[key]) && value[key] >= 0,
      `wire proxy evidence ${key} is invalid`,
    );
  }
  invariant(value.droppedCount <= 1, 'wire proxy dropped more than one exact terminal');
  invariant(value.mutatedCount <= 1, 'wire proxy mutated more than one exact terminal');
  for (const key of [
    'firstExecuteAt',
    'lastExecuteAt',
    'firstTerminalAt',
    'lastForwardedTerminalAt',
  ]) {
    invariant(validIso(value[key]), `wire proxy evidence ${key} is invalid`);
  }
  return value;
}

function parseEnvelope(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function exactTaskPayload(envelope, config) {
  const payload = envelope?.payload;
  return (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    payload.taskId === config.taskId &&
    payload.payloadHash === config.payloadHash
  );
}

export function observeBackendWireFrame(text, config, evidence, now = new Date()) {
  const envelope = parseEnvelope(text);
  if (
    envelope?.kind !== 'task.execute.v1' ||
    !exactTaskPayload(envelope, config) ||
    envelope.payload.kind !== expectedTaskKind
  ) {
    return { matchingExecute: false, evidence };
  }
  const observedAt = now.toISOString();
  return {
    matchingExecute: true,
    evidence: {
      ...evidence,
      executeCount: evidence.executeCount + 1,
      firstExecuteAt: evidence.firstExecuteAt ?? observedAt,
      lastExecuteAt: observedAt,
    },
  };
}

export function transformAgentWireFrame(text, config, evidence, options = {}) {
  const envelope = parseEnvelope(text);
  const status = envelope?.payload?.status;
  if (
    envelope?.kind !== 'task.result.v1' ||
    !exactTaskPayload(envelope, config) ||
    (status !== 'succeeded' && status !== 'failed')
  ) {
    return { action: 'forward', text, evidence };
  }

  const observedAt = (options.now ?? new Date()).toISOString();
  let next = {
    ...evidence,
    terminalCount: evidence.terminalCount + 1,
    firstTerminalAt: evidence.firstTerminalAt ?? observedAt,
  };

  if (config.mode === 'drop-terminal-once' && evidence.droppedCount === 0) {
    next = { ...next, droppedCount: 1 };
    return { action: 'drop-and-cut', text: null, evidence: next };
  }
  if (config.mode === 'drop-terminal-once' && options.released !== true) {
    return { action: 'drop-and-cut', text: null, evidence: next };
  }
  if (config.mode === 'hold-terminal-until-release' && options.released !== true) {
    next = { ...next, droppedCount: 1 };
    return { action: 'drop', text: null, evidence: next };
  }

  let forwardedText = text;
  if (
    config.mode === 'mutate-image-ref-once' &&
    evidence.mutatedCount === 0 &&
    evidence.executeCount > 0 &&
    status === 'succeeded' &&
    envelope.payload.result &&
    typeof envelope.payload.result === 'object' &&
    !Array.isArray(envelope.payload.result) &&
    typeof envelope.payload.result.dockerRef === 'string'
  ) {
    envelope.payload.result.dockerRef = `registry:5000/${config.runId}/provider-invalid-result:${config.nodeKey}`;
    forwardedText = JSON.stringify(envelope);
    next = { ...next, mutatedCount: 1 };
  }
  next = {
    ...next,
    forwardedTerminalCount: next.forwardedTerminalCount + 1,
    lastForwardedTerminalAt: observedAt,
  };
  return { action: 'forward', text: forwardedText, evidence: next };
}

function assertPrivateFile(path, label) {
  const stat = statSync(path);
  invariant(stat.isFile() && (stat.mode & 0o077) === 0, `${label} is not a private file`);
}

function readConfig() {
  assertPrivateFile(configPath, 'wire proxy config');
  return validateWireProxyConfig(JSON.parse(readFileSync(configPath, 'utf8')));
}

function readEvidence(config) {
  if (!existsSync(evidencePath)) return createWireProxyEvidence(config);
  assertPrivateFile(evidencePath, 'wire proxy evidence');
  return validateWireProxyEvidence(JSON.parse(readFileSync(evidencePath, 'utf8')), config);
}

function persistEvidence(value, config) {
  validateWireProxyEvidence(value, config);
  const temporaryPath = `${evidencePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'w' });
  renameSync(temporaryPath, evidencePath);
}

function rawDataLength(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((total, part) => total + part.byteLength, 0);
  return maxPayloadBytes + 1;
}

async function main() {
  const config = readConfig();
  assertPrivateFile(certificatePath, 'wire proxy certificate');
  assertPrivateFile(privateKeyPath, 'wire proxy private key');
  let evidence = readEvidence(config);
  persistEvidence(evidence, config);

  const requireFromAgent = createRequire('/opt/nyabase-agent/package.json');
  const { WebSocket, WebSocketServer } = requireFromAgent('ws');
  const server = createServer(
    {
      cert: readFileSync(certificatePath),
      key: readFileSync(privateKeyPath),
    },
    (_request, response) => {
      response.writeHead(404, { 'content-length': '0' });
      response.end();
    },
  );
  const socketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxPayloadBytes,
    perMessageDeflate: false,
  });

  const commit = (value) => {
    evidence = value;
    persistEvidence(evidence, config);
  };
  const cutActive = () =>
    config.mode === 'drop-terminal-once' && evidence.droppedCount === 1 && !existsSync(releasePath);

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws/agent' || cutActive()) {
      socket.destroy();
      return;
    }
    socketServer.handleUpgrade(request, socket, head, (client) => {
      socketServer.emit('connection', client, request);
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('tlsClientError', () => undefined);

  socketServer.on('connection', (client, request) => {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || cutActive()) {
      client.terminate();
      return;
    }

    const upstream = new WebSocket(`ws://${config.backendIp}:3001/ws/agent`, {
      headers: {
        authorization,
        host: 'edge',
        'x-forwarded-proto': 'https',
      },
      maxPayload: maxPayloadBytes,
      perMessageDeflate: false,
    });
    const queued = [];
    let queuedBytes = 0;
    let closed = false;
    const terminatePair = () => {
      if (closed) return;
      closed = true;
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.terminate();
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      }
    };

    client.on('message', (data, isBinary) => {
      if (closed || cutActive()) {
        terminatePair();
        return;
      }
      let outgoing = data;
      if (!isBinary) {
        const transformed = transformAgentWireFrame(data.toString('utf8'), config, evidence, {
          released: existsSync(releasePath),
        });
        if (transformed.evidence !== evidence) commit(transformed.evidence);
        if (transformed.action === 'drop-and-cut') {
          terminatePair();
          return;
        }
        if (transformed.action === 'drop') return;
        outgoing = transformed.text;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(outgoing, { binary: isBinary });
        return;
      }
      queuedBytes += rawDataLength(outgoing);
      if (queuedBytes > maxPayloadBytes) {
        terminatePair();
        return;
      }
      queued.push({ data: outgoing, isBinary });
    });

    upstream.on('open', () => {
      for (const message of queued.splice(0)) {
        if (closed || upstream.readyState !== WebSocket.OPEN) break;
        upstream.send(message.data, { binary: message.isBinary });
      }
    });
    upstream.on('message', (data, isBinary) => {
      if (closed || cutActive()) {
        terminatePair();
        return;
      }
      if (!isBinary) {
        const observed = observeBackendWireFrame(data.toString('utf8'), config, evidence);
        if (observed.evidence !== evidence) commit(observed.evidence);
      }
      if (client.readyState !== WebSocket.OPEN) {
        terminatePair();
        return;
      }
      client.send(data, { binary: isBinary });
    });
    client.on('close', terminatePair);
    client.on('error', terminatePair);
    upstream.on('close', terminatePair);
    upstream.on('error', terminatePair);
  });

  server.listen(config.listenPort, '0.0.0.0');
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === invokedUrl) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
