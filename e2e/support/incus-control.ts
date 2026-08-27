import { spawn } from 'node:child_process';

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

export async function runIncus(args: readonly string[]): Promise<CommandResult> {
  return runCommand('incus', args);
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
