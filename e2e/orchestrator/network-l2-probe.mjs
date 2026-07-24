#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  aggregateErrorWithDiagnostics,
  runCleanupStepsPreservingPrimary,
  runEntrypointWithDiagnostics,
} from '../support/error-diagnostics.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const runtimeBase = resolve(dirname(scriptPath), '..', '.runtime');
const runtimeDir = resolve(process.argv[2] ?? '');
const workloadTag = process.argv[3];
const maxBuffer = 8 * 1024 * 1024;
const dockerSocket = 'unix:///run/nyabase-agent/docker.sock';
const managedNetwork = 'nyabase_net';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function command(program, args, options = {}) {
  const result = await execFile(program, args, {
    encoding: 'utf8',
    maxBuffer,
    timeout: options.timeout ?? 30_000,
  });
  return result.stdout.trim();
}

async function commandResult(program, args, options = {}) {
  try {
    return { code: 0, stdout: await command(program, args, options), stderr: '' };
  } catch (error) {
    if (Number.isInteger(error?.code)) {
      return {
        code: error.code,
        stdout: String(error.stdout ?? '').trim(),
        stderr: String(error.stderr ?? '').trim(),
      };
    }
    throw error;
  }
}

const docker = (args, options) => command('docker', args, options);
const dockerResult = (args, options) => commandResult('docker', args, options);
const nodeDockerArgs = (nodeName, args) => [
  'exec',
  nodeName,
  '/usr/bin/docker',
  '--host',
  dockerSocket,
  ...args,
];
const nodeDocker = (nodeName, args, options) => docker(nodeDockerArgs(nodeName, args), options);
const nodeDockerResult = (nodeName, args, options) =>
  dockerResult(nodeDockerArgs(nodeName, args), options);

async function writePrivateAtomic(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function retry(description, operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  throw new Error(`${description} did not converge within ${timeoutMs}ms: ${String(lastError)}`);
}

function addressPlan(subnet) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.0\/24$/.exec(subnet);
  invariant(match, `the Docker DinD provider requires a canonical /24 subnet, got ${subnet}`);
  const prefix = `${match[1]}.${match[2]}.${match[3]}`;
  return {
    node1Server: `${prefix}.101`,
    node1Client: `${prefix}.102`,
    node2Server: `${prefix}.103`,
    node2Client: `${prefix}.104`,
  };
}

function safeNetworkIdentity(value, nodeKey, state) {
  const ipam = value?.IPAM?.Config ?? [];
  invariant(value?.Name === managedNetwork, `${nodeKey} managed network name mismatch`);
  invariant(value?.Driver === 'macvlan', `${nodeKey} managed network driver is not macvlan`);
  invariant(value?.Options?.parent === 'eth0', `${nodeKey} managed network parent is not eth0`);
  invariant(
    ipam.length === 1 &&
      ipam[0]?.Subnet === state.NYABASE_E2E_SUBNET &&
      ipam[0]?.Gateway === state.NYABASE_E2E_GATEWAY,
    `${nodeKey} managed network IPAM mismatch`,
  );
  return {
    nodeKey,
    name: value.Name,
    driver: value.Driver,
    parent: value.Options.parent,
    subnet: ipam[0].Subnet,
    gateway: ipam[0].Gateway,
  };
}

async function main() {
  invariant(
    process.argv[2] && workloadTag,
    'usage: network-l2-probe.mjs <runtimeDir> <workloadTag>',
  );
  invariant(
    runtimeDir.startsWith(`${runtimeBase}${sep}`) && dirname(runtimeDir) === runtimeBase,
    `runtime directory must be a direct child of ${runtimeBase}`,
  );
  const runtimeInfo = await lstat(runtimeDir);
  invariant(
    runtimeInfo.isDirectory() && !runtimeInfo.isSymbolicLink(),
    'runtime directory must be real',
  );
  invariant((runtimeInfo.mode & 0o077) === 0, 'runtime directory must be private');
  const { state, runId } = await loadValidatedRunState(runtimeDir);
  invariant(/^[a-z0-9][a-z0-9-]{2,47}$/.test(runId), 'state runId is invalid');
  invariant(runtimeDir.split(sep).at(-1) === runId, 'runtime runId mismatch');
  invariant(
    workloadTag === `registry:5000/${runId}/workload:immutable`,
    'network probe workload tag is not the run-scoped immutable fixture tag',
  );

  const addresses = addressPlan(state.NYABASE_E2E_SUBNET);
  const nodeNames = {
    node1: `${state.NYABASE_E2E_PREFIX}-node1`,
    node2: `${state.NYABASE_E2E_PREFIX}-node2`,
  };
  const innerNames = {
    node1Server: `${runId}-l2-n1-server`,
    node1Client: `${runId}-l2-n1-client`,
    node2Server: `${runId}-l2-n2-server`,
    node2Client: `${runId}-l2-n2-client`,
  };
  const outerClient = `${state.NYABASE_E2E_PREFIX}-independent-client`;
  const labelArgs = [
    '--label',
    `io.nyabase.e2e.run-id=${runId}`,
    '--label',
    'io.nyabase.e2e.probe=shared-macvlan-l2',
  ];
  const cleanupChecks = [];
  const checks = [];
  const startedAt = new Date().toISOString();
  let primaryFailure = null;
  let networkIdentities = [];
  let persistentClient = null;

  const recordCheck = async ({ name, source, target, protocol, execute, expected }) => {
    const output = await execute();
    if (expected !== undefined)
      invariant(output === expected, `${name} returned unexpected content`);
    checks.push({ name, source, target, protocol, passed: true });
  };

  try {
    networkIdentities = await Promise.all(
      Object.entries(nodeNames).map(async ([nodeKey, nodeName]) => {
        const raw = await nodeDocker(nodeName, ['network', 'inspect', managedNetwork]);
        const parsed = JSON.parse(raw);
        invariant(
          Array.isArray(parsed) && parsed.length === 1,
          `${nodeKey} network inspect is ambiguous`,
        );
        return safeNetworkIdentity(parsed[0], nodeKey, state);
      }),
    );
    const outerInspect = JSON.parse(await docker(['inspect', outerClient]));
    invariant(
      Array.isArray(outerInspect) && outerInspect.length === 1,
      'independent client inspect is ambiguous',
    );
    invariant(outerInspect[0]?.State?.Running === true, 'independent client is not running');
    invariant(
      outerInspect[0]?.Config?.Labels?.['io.nyabase.e2e.run-id'] === runId &&
        outerInspect[0]?.NetworkSettings?.Networks?.[state.NYABASE_E2E_NETWORK]?.IPAddress ===
          state.NYABASE_E2E_PROBE_IP,
      'independent client run identity mismatch',
    );
    persistentClient = {
      name: outerClient,
      address: state.NYABASE_E2E_PROBE_IP,
      network: state.NYABASE_E2E_NETWORK,
      running: true,
    };
    const token = `nyabase-l2-${runId}`;

    const startInner = async (nodeName, name, ip, role) => {
      const commandArgs =
        role === 'server'
          ? [
              '-ec',
              `while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: ${Buffer.byteLength(token)}\\r\\nConnection: close\\r\\n\\r\\n${token}' | nc -l -p 8080; done`,
            ]
          : ['-ec', 'exec tail -f /dev/null'];
      await nodeDocker(nodeName, [
        'run',
        '-d',
        '--name',
        name,
        '--network',
        managedNetwork,
        '--ip',
        ip,
        ...labelArgs,
        '--entrypoint',
        '/bin/sh',
        workloadTag,
        ...commandArgs,
      ]);
    };

    await startInner(nodeNames.node1, innerNames.node1Server, addresses.node1Server, 'server');
    await startInner(nodeNames.node1, innerNames.node1Client, addresses.node1Client, 'client');
    await startInner(nodeNames.node2, innerNames.node2Server, addresses.node2Server, 'server');
    await startInner(nodeNames.node2, innerNames.node2Client, addresses.node2Client, 'client');
    const innerExec = (nodeName, containerName, args) =>
      nodeDocker(nodeName, ['exec', containerName, ...args]);
    const ping = (nodeName, containerName, target) =>
      innerExec(nodeName, containerName, ['ping', '-c', '2', '-W', '2', target]);
    const http = (nodeName, containerName, target) =>
      innerExec(nodeName, containerName, [
        'wget',
        '-q',
        '-T',
        '3',
        '-O',
        '-',
        `http://${target}:8080/`,
      ]);
    const outerExec = (args) => docker(['exec', outerClient, ...args]);

    await retry('node1 same-node HTTP server', () =>
      http(nodeNames.node1, innerNames.node1Client, addresses.node1Server),
    );
    await retry('node2 same-node HTTP server', () =>
      http(nodeNames.node2, innerNames.node2Client, addresses.node2Server),
    );

    const definitions = [
      {
        name: 'same-node-node1-ping',
        source: addresses.node1Client,
        target: addresses.node1Server,
        protocol: 'icmp',
        execute: () => ping(nodeNames.node1, innerNames.node1Client, addresses.node1Server),
      },
      {
        name: 'same-node-node1-reverse-ping',
        source: addresses.node1Server,
        target: addresses.node1Client,
        protocol: 'icmp',
        execute: () => ping(nodeNames.node1, innerNames.node1Server, addresses.node1Client),
      },
      {
        name: 'same-node-node1-http',
        source: addresses.node1Client,
        target: addresses.node1Server,
        protocol: 'http',
        execute: () => http(nodeNames.node1, innerNames.node1Client, addresses.node1Server),
        expected: token,
      },
      {
        name: 'same-node-node2-ping',
        source: addresses.node2Client,
        target: addresses.node2Server,
        protocol: 'icmp',
        execute: () => ping(nodeNames.node2, innerNames.node2Client, addresses.node2Server),
      },
      {
        name: 'same-node-node2-reverse-ping',
        source: addresses.node2Server,
        target: addresses.node2Client,
        protocol: 'icmp',
        execute: () => ping(nodeNames.node2, innerNames.node2Server, addresses.node2Client),
      },
      {
        name: 'same-node-node2-http',
        source: addresses.node2Client,
        target: addresses.node2Server,
        protocol: 'http',
        execute: () => http(nodeNames.node2, innerNames.node2Client, addresses.node2Server),
        expected: token,
      },
      {
        name: 'cross-node-node1-to-node2-ping',
        source: addresses.node1Client,
        target: addresses.node2Server,
        protocol: 'icmp',
        execute: () => ping(nodeNames.node1, innerNames.node1Client, addresses.node2Server),
      },
      {
        name: 'cross-node-node1-to-node2-http',
        source: addresses.node1Client,
        target: addresses.node2Server,
        protocol: 'http',
        execute: () => http(nodeNames.node1, innerNames.node1Client, addresses.node2Server),
        expected: token,
      },
      {
        name: 'cross-node-node2-to-node1-ping',
        source: addresses.node2Client,
        target: addresses.node1Server,
        protocol: 'icmp',
        execute: () => ping(nodeNames.node2, innerNames.node2Client, addresses.node1Server),
      },
      {
        name: 'cross-node-node2-to-node1-http',
        source: addresses.node2Client,
        target: addresses.node1Server,
        protocol: 'http',
        execute: () => http(nodeNames.node2, innerNames.node2Client, addresses.node1Server),
        expected: token,
      },
      {
        name: 'outer-client-to-node1-ping',
        source: state.NYABASE_E2E_PROBE_IP,
        target: addresses.node1Server,
        protocol: 'icmp',
        execute: () => outerExec(['ping', '-c', '2', '-W', '2', addresses.node1Server]),
      },
      {
        name: 'outer-client-to-node1-http',
        source: state.NYABASE_E2E_PROBE_IP,
        target: addresses.node1Server,
        protocol: 'http',
        execute: () =>
          outerExec(['wget', '-q', '-T', '3', '-O', '-', `http://${addresses.node1Server}:8080/`]),
        expected: token,
      },
      {
        name: 'outer-client-to-node2-ping',
        source: state.NYABASE_E2E_PROBE_IP,
        target: addresses.node2Server,
        protocol: 'icmp',
        execute: () => outerExec(['ping', '-c', '2', '-W', '2', addresses.node2Server]),
      },
      {
        name: 'outer-client-to-node2-http',
        source: state.NYABASE_E2E_PROBE_IP,
        target: addresses.node2Server,
        protocol: 'http',
        execute: () =>
          outerExec(['wget', '-q', '-T', '3', '-O', '-', `http://${addresses.node2Server}:8080/`]),
        expected: token,
      },
      {
        name: 'node1-to-outer-client-ping',
        source: addresses.node1Client,
        target: state.NYABASE_E2E_PROBE_IP,
        protocol: 'icmp',
        execute: () => ping(nodeNames.node1, innerNames.node1Client, state.NYABASE_E2E_PROBE_IP),
      },
      {
        name: 'node2-to-outer-client-ping',
        source: addresses.node2Client,
        target: state.NYABASE_E2E_PROBE_IP,
        protocol: 'icmp',
        execute: () => ping(nodeNames.node2, innerNames.node2Client, state.NYABASE_E2E_PROBE_IP),
      },
    ];

    for (const definition of definitions) await recordCheck(definition);
  } catch (error) {
    primaryFailure = { error };
  }

  const cleanupTargets = [
    [nodeNames.node1, innerNames.node1Server],
    [nodeNames.node1, innerNames.node1Client],
    [nodeNames.node2, innerNames.node2Server],
    [nodeNames.node2, innerNames.node2Client],
  ];
  await runCleanupStepsPreservingPrimary(
    'network L2 probe and cleanup failed',
    cleanupTargets.map(([nodeName, containerName]) => async () => {
      let removed = null;
      let absent = null;
      const operationFailures = [];
      try {
        removed = await nodeDockerResult(nodeName, ['rm', '-f', containerName]);
      } catch (error) {
        operationFailures.push(error);
      }
      try {
        absent = await nodeDockerResult(nodeName, ['inspect', containerName]);
      } catch (error) {
        operationFailures.push(error);
      }
      const removalAccepted =
        removed !== null &&
        (removed.code === 0 || /No such container/i.test(removed.stderr));
      const absenceProved =
        absent !== null &&
        absent.code !== 0 &&
        /No such (object|container)/i.test(absent.stderr);
      cleanupChecks.push({
        scope: nodeName,
        containerName,
        removalAccepted,
        absent: absenceProved,
      });
      if (!removalAccepted && operationFailures.length === 0) {
        operationFailures.push(new Error(`${containerName} removal was not accepted`));
      }
      if (!absenceProved && operationFailures.length === 0) {
        operationFailures.push(new Error(`${containerName} absence was not proved`));
      }
      if (operationFailures.length === 1) throw operationFailures[0];
      if (operationFailures.length > 1) {
        throw aggregateErrorWithDiagnostics(
          `${containerName} cleanup had multiple command failures`,
          operationFailures,
        );
      }
    }),
    primaryFailure,
  );

  const cleanupPassed =
    cleanupChecks.length === 4 &&
    cleanupChecks.every((check) => check.removalAccepted && check.absent);
  invariant(
    cleanupPassed,
    'network L2 probe cleanup did not prove every temporary container absent',
  );
  invariant(
    checks.length === 16 && checks.every((check) => check.passed),
    'network L2 probe is incomplete',
  );
  const retainedClient = JSON.parse(await docker(['inspect', outerClient]));
  invariant(
    persistentClient &&
      Array.isArray(retainedClient) &&
      retainedClient.length === 1 &&
      retainedClient[0]?.State?.Running === true,
    'independent client did not survive the temporary L2 probe',
  );

  const evidence = {
    schemaVersion: 1,
    runId,
    capability: 'shared-macvlan-l2',
    status: 'passed',
    startedAt,
    observedAt: new Date().toISOString(),
    workloadPool: {
      cidr: state.NYABASE_E2E_SUBNET,
      firstAddress: addressPlan(state.NYABASE_E2E_SUBNET).node1Server,
      lastAddress: state.NYABASE_E2E_SUBNET.replace(/\.0\/24$/, '.199'),
    },
    addresses: { ...addresses, independentClient: state.NYABASE_E2E_PROBE_IP },
    independentClient: persistentClient,
    networks: networkIdentities.sort((left, right) => left.nodeKey.localeCompare(right.nodeKey)),
    checks,
    cleanup: { status: 'clean', containers: cleanupChecks },
  };
  const outputPath = join(runtimeDir, 'fixture-evidence', 'network-l2-provider-probe.json');
  await writePrivateAtomic(outputPath, evidence);
  console.log(
    `shared macvlan L2 probe PASS: ${checks.length} ICMP/HTTP paths and scoped cleanup proved`,
  );
}

await runEntrypointWithDiagnostics(main);
