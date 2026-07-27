#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod, lstat, mkdir, open, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { validateProxyClientInput } from './proxy-client-contract.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

const execFile = promisify(execFileCallback);
const runtimeDir = resolve(process.argv[2] ?? '');
const runtimeBase = resolve(dirname(new URL(import.meta.url).pathname), '..', '.runtime');
if (!process.argv[2]) throw new Error('usage: proxy-client-control.mjs <runtimeDir>');
if (!runtimeDir.startsWith(`${runtimeBase}${sep}`) || dirname(runtimeDir) !== runtimeBase) {
  throw new Error('Proxy client operation escaped the E2E runtime boundary');
}
const runtimeInfo = await lstat(runtimeDir);
if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink() || (runtimeInfo.mode & 0o077) !== 0) {
  throw new Error('Proxy client runtime directory is not private and real');
}
const { state } = await loadValidatedRunState(runtimeDir);
if (!['full', 'recovery'].includes(state.NYABASE_E2E_PROFILE)) {
  throw new Error('Proxy client requires a proxy-enabled profile');
}

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 8192) throw new Error('Proxy client input is too large');
}
let input;
try { input = JSON.parse(raw); } catch { throw new Error('Proxy client input is not valid JSON'); }
input = validateProxyClientInput(input, state.NYABASE_E2E_RUN_ID);
if (input.runId !== runtimeDir.split(sep).at(-1)) throw new Error('Proxy client runtime identity mismatch');

const proxyDir = join(runtimeDir, 'proxies');
const clientDir = join(proxyDir, 'client-runtime');
const privateKey = join(proxyDir, 'external-key');
const knownHosts = join(clientDir, 'known-hosts');
const holdPidFile = join(clientDir, 'ssh-hold.json');
const holdLog = join(clientDir, 'ssh-hold.log');
await mkdir(clientDir, { recursive: true, mode: 0o700 });
const sshIp = state.NYABASE_E2E_SSH_PROXY_IP;
const httpIp = state.NYABASE_E2E_HTTP_PROXY_IP;
const sshPort = '2222';
const maxBuffer = 64 * 1024;
const command = (file, args, timeout = 30_000) => execFile(file, args, {
  encoding: 'utf8', maxBuffer, timeout,
});

const result = {
  schemaVersion: 1,
  runId: input.runId,
  action: input.action,
  source: 'host-default-openssh',
  sshProxyIp: sshIp,
  httpProxyIp: httpIp,
  login: null,
  hostname: null,
  hostKeyFingerprint: null,
  markerMatched: null,
  httpStatus: null,
  sftpBytes: null,
  sftpSha256: null,
  holdPid: null,
  holdAlive: null,
  defaultSendEnv: null,
  observedAt: new Date().toISOString(),
};

async function scanHostKey() {
  let stdout = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      ({ stdout } = await command('ssh-keyscan', ['-T', '2', '-p', sshPort, sshIp], 5_000));
      if (stdout.trim()) break;
    } catch { /* bounded retry */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (!stdout.trim()) throw new Error('SSH proxy host key scan did not converge');
  await writeFile(knownHosts, stdout, { mode: 0o600 });
  await chmod(knownHosts, 0o600);
  const fingerprint = (await command('ssh-keygen', ['-lf', knownHosts, '-E', 'sha256']))
    .stdout.trim().split(/\s+/)[1];
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint ?? '')) {
    throw new Error('SSH proxy host key fingerprint is invalid');
  }
  return fingerprint;
}

function loginFor(target) {
  return `admin.${input.runId}-${target.nodeKey}.${target.containerName}`;
}

function sshOptions(login) {
  return [
    '-p', sshPort,
    '-i', privateKey,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'ConnectTimeout=10',
    '-o', 'ConnectionAttempts=1',
    `${login}@${sshIp}`,
  ];
}

async function defaultSendEnv() {
  const { stdout } = await command('ssh', ['-G', sshIp], 10_000);
  return stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('sendenv '))
    .map((line) => line.slice('sendenv '.length))
    .sort();
}

async function holdIdentity() {
  try {
    const stored = JSON.parse(await readFile(holdPidFile, 'utf8'));
    if (!Number.isSafeInteger(stored.pid) || stored.pid < 1 || stored.runId !== input.runId) {
      throw new Error('SSH hold identity is invalid');
    }
    try {
      const cmdline = (await readFile(`/proc/${stored.pid}/cmdline`)).toString('utf8');
      const alive = cmdline.includes('\0ssh\0') || cmdline.startsWith('ssh\0');
      return { pid: stored.pid, alive: alive && cmdline.includes(input.runId) && cmdline.includes(sshIp) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { pid: stored.pid, alive: false };
      throw error;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { pid: null, alive: false };
    throw error;
  }
}

async function httpGet(hostname, marker) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request({
      host: httpIp,
      port: 8080,
      method: 'GET',
      path: `/e2e/${marker}`,
      headers: { Host: hostname, Connection: 'close' },
      timeout: 10_000,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBuffer) request.destroy(new Error('HTTP proxy response is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolvePromise({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('timeout', () => request.destroy(new Error('HTTP proxy request timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function websocketEcho(hostname, marker) {
  const key = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host: httpIp, port: 8080 });
    const timer = setTimeout(() => socket.destroy(new Error('WebSocket proxy probe timed out')), 10_000);
    let pending = Buffer.alloc(0);
    let upgraded = false;
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(value);
    };
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => {
      socket.write([
        'GET /e2e/websocket HTTP/1.1',
        `Host: ${hostname}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (!upgraded) {
        const headerEnd = pending.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = pending.subarray(0, headerEnd).toString('utf8');
        pending = pending.subarray(headerEnd + 4);
        if (!header.startsWith('HTTP/1.1 101 ') || !header.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)) {
          finish(new Error('HTTP proxy rejected the WebSocket upgrade'));
          return;
        }
        upgraded = true;
        const payload = Buffer.from(marker);
        const mask = randomBytes(4);
        const masked = Buffer.from(payload);
        for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
        socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
      }
      if (upgraded && pending.length >= 2) {
        const length = pending[1] & 0x7f;
        if ((pending[0] & 0x0f) !== 1 || length > 125 || pending.length < 2 + length) return;
        const echoed = pending.subarray(2, 2 + length).toString('utf8');
        finish(undefined, echoed === marker);
      }
    });
  });
}

if (input.action === 'sshHostKey') {
  result.hostKeyFingerprint = await scanHostKey();
  result.defaultSendEnv = await defaultSendEnv();
} else if (input.action === 'sshExec') {
  result.login = loginFor(input);
  result.hostKeyFingerprint = await scanHostKey();
  result.defaultSendEnv = await defaultSendEnv();
  const { stdout } = await command('ssh', [
    ...sshOptions(result.login), '/bin/echo', input.marker,
  ], 30_000);
  result.markerMatched = stdout.trim() === input.marker;
} else if (input.action === 'sftpRoundTrip') {
  result.login = loginFor(input);
  result.hostKeyFingerprint = await scanHostKey();
  result.defaultSendEnv = await defaultSendEnv();
  const upload = join(clientDir, 'sftp-upload.txt');
  const download = join(clientDir, 'sftp-download.txt');
  const batch = join(clientDir, 'sftp.batch');
  await writeFile(upload, `${input.marker}\n`, { mode: 0o600 });
  await rm(download, { force: true });
  await writeFile(batch, `put ${upload} /tmp/nyabase-e2e-sftp.txt\nget /tmp/nyabase-e2e-sftp.txt ${download}\n`, { mode: 0o600 });
  await command('sftp', [
    '-q', '-b', batch, '-P', sshPort,
    '-o', `IdentityFile=${privateKey}`,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'ConnectTimeout=10',
    `${result.login}@${sshIp}`,
  ], 30_000);
  const [sent, received] = await Promise.all([readFile(upload), readFile(download)]);
  result.markerMatched = sent.equals(received);
  result.sftpBytes = received.length;
  result.sftpSha256 = createHash('sha256').update(received).digest('hex');
} else if (input.action === 'sshHoldStart') {
  const prior = await holdIdentity();
  if (prior.alive) throw new Error('an exact SSH hold is already active');
  result.login = loginFor(input);
  result.hostKeyFingerprint = await scanHostKey();
  const logHandle = await open(holdLog, 'w', 0o600);
  const child = spawn('ssh', [
    ...sshOptions(result.login), `printf '${input.marker}\\n'; exec sleep 300`,
  ], { detached: true, stdio: ['ignore', logHandle.fd, logHandle.fd] });
  child.unref();
  await logHandle.close();
  await writeFile(holdPidFile, `${JSON.stringify({
    schemaVersion: 1, runId: input.runId, pid: child.pid,
  })}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await readFile(holdLog, 'utf8').catch(() => '')).includes(input.marker)) break;
    if (!(await holdIdentity()).alive) throw new Error('SSH hold exited before readiness');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const held = await holdIdentity();
  if (!held.alive || !(await readFile(holdLog, 'utf8')).includes(input.marker)) {
    throw new Error('SSH hold did not become ready');
  }
  result.markerMatched = true;
  result.holdPid = held.pid;
  result.holdAlive = true;
} else if (input.action === 'sshHoldProbe' || input.action === 'sshHoldRelease') {
  const held = await holdIdentity();
  if (input.action === 'sshHoldRelease' && held.alive) {
    process.kill(held.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 100 && (await holdIdentity()).alive; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  const after = await holdIdentity();
  result.holdPid = held.pid;
  result.holdAlive = after.alive;
  if (!after.alive) await rm(holdPidFile, { force: true });
} else if (input.action === 'httpGet') {
  result.hostname = input.hostname;
  const response = await httpGet(input.hostname, input.marker);
  result.httpStatus = response.status;
  result.markerMatched = response.body === `nyabase-real-proxy-target:/e2e/${input.marker}`;
} else if (input.action === 'websocketEcho') {
  result.hostname = input.hostname;
  result.httpStatus = 101;
  result.markerMatched = await websocketEcho(input.hostname, input.marker);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
