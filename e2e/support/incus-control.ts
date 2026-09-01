import { spawn } from 'node:child_process';
import { currentRunId } from './runtime-env.js';

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface IncusStoragePool {
  readonly name: string;
  readonly driver: string;
  readonly config: Record<string, string>;
}

const allowedTargets = new Set<string>();

export function allowIncusTarget(name: string): void {
  if (!name) throw new Error('allowIncusTarget requires a name');
  allowedTargets.add(name);
}

export function extractIncusObjectNames(args: readonly string[]): string[] {
  if (args.length === 0) return [];
  const command = args[0];
  if (command === 'list' || command === 'storage' || command === 'image' || command === 'network') {
    return [];
  }
  const positional = args.slice(1).filter((value) => value !== '--' && !value.startsWith('-'));
  const skip = new Set(['device', 'add', 'get', 'set', 'remove', 'show', 'unset', 'edit']);
  if (command === 'config') {
    const name = positional.find((value) => !skip.has(value));
    return name ? [name] : [];
  }
  if (command === 'init') {
    return positional.length > 0 ? [positional[positional.length - 1]] : [];
  }
  if (command === 'exec' || command === 'start' || command === 'stop' || command === 'delete') {
    return positional.length > 0 ? [positional[0]] : [];
  }
  return [];
}

function assertAllowedTargets(args: readonly string[]): void {
  const runId = currentRunId();
  for (const name of extractIncusObjectNames(args)) {
    const allowed = name.startsWith(`e2e-${runId}-`) || allowedTargets.has(name);
    if (!allowed) {
      throw new Error(`runIncus refused ${name}: not in run ${runId} allow set`);
    }
  }
}

export async function runIncus(args: readonly string[]): Promise<CommandResult> {
  assertAllowedTargets(args);
  return runCommand('incus', args);
}

export async function execGuest(instanceName: string, shell: string): Promise<CommandResult> {
  return runIncus(['exec', instanceName, '--', '/bin/sh', '-lc', shell]);
}

export async function runCommand(
  command: string,
  args: readonly string[],
  input?: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code: code ?? 1,
      stdout,
      stderr,
    }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function readStoragePools(): Promise<IncusStoragePool[]> {
  const result = await runIncus(['storage', 'list', '--format', 'json']);
  if (result.code !== 0) {
    throw new Error(`Incus storage inspection failed with exit code ${result.code}`);
  }
  const values = JSON.parse(result.stdout) as Array<{
    name: string;
    driver: string;
    config?: Record<string, string>;
  }>;
  return values.map((value) => ({
    name: value.name,
    driver: value.driver,
    config: value.config ?? {},
  }));
}

export async function assertCommand(
  command: string,
  args: readonly string[],
  detail: string,
): Promise<void> {
  const result = await runCommand(command, args);
  if (result.code !== 0) {
    throw new Error(`BLOCKED: ${detail} (exit ${result.code})`);
  }
}

export function registerControlPlaneNamesFromJson(value: unknown): void {
  visitJson(value, (record) => {
    for (const key of ['instanceName', 'volumeName']) {
      const name = record[key];
      if (typeof name === 'string' && (name.startsWith('nyc-') || name.startsWith('nyv-'))) {
        allowIncusTarget(name);
      }
    }
  });
}

function visitJson(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) visitJson(entry, visit);
    return;
  }
  visit(value as Record<string, unknown>);
  for (const child of Object.values(value)) visitJson(child, visit);
}
