#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadValidatedRunState } from './run-state-contract.mjs';

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const runtimeBase = resolve(dirname(scriptPath), '..', '.runtime');
const runtimeDir = resolve(process.argv[2] ?? '');
const targetIp = process.argv[3];
const expectedBody = process.argv[4];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function docker(args) {
  const result = await execFile('docker', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
  });
  return result.stdout.trim();
}

invariant(
  process.argv[2] && targetIp && expectedBody,
  'usage: independent-network-client.mjs <runtimeDir> <targetIp> <expectedBody>',
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
const subnetMatch = /^(\d+)\.(\d+)\.(\d+)\.0\/24$/.exec(state.NYABASE_E2E_SUBNET);
invariant(subnetMatch, 'provider subnet is not a canonical /24');
const prefix = `${subnetMatch[1]}.${subnetMatch[2]}.${subnetMatch[3]}`;
const targetMatch = new RegExp(`^${prefix.replaceAll('.', '\\.')}\\.(\\d+)$`).exec(targetIp);
invariant(targetMatch, 'target is outside the current provider subnet');
const targetHost = Number(targetMatch[1]);
invariant(targetHost >= 101 && targetHost <= 199, 'target is outside the product workload pool');
invariant(
  /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(expectedBody),
  'expected HTTP body is not a bounded safe marker',
);

const clientName = `${state.NYABASE_E2E_PREFIX}-independent-client`;
const inspect = JSON.parse(await docker(['inspect', clientName]));
invariant(
  Array.isArray(inspect) && inspect.length === 1,
  'independent client identity is ambiguous',
);
const client = inspect[0];
invariant(client?.State?.Running === true, 'independent client is not running');
invariant(
  client?.Config?.Labels?.['io.nyabase.e2e.run-id'] === runId,
  'independent client run label mismatch',
);
invariant(
  client?.NetworkSettings?.Networks?.[state.NYABASE_E2E_NETWORK]?.IPAddress ===
    state.NYABASE_E2E_PROBE_IP,
  'independent client address or network mismatch',
);

await docker(['exec', clientName, 'ping', '-c', '2', '-W', '2', targetIp]);
const body = await docker([
  'exec',
  clientName,
  'wget',
  '-q',
  '-T',
  '3',
  '-O',
  '-',
  `http://${targetIp}:8080/`,
]);
invariant(body === expectedBody, 'independent client received an unexpected HTTP response');
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    runId,
    sourceIp: state.NYABASE_E2E_PROBE_IP,
    targetIp,
    protocols: { icmp: 'passed', http: 'passed' },
  })}\n`,
);
