import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './incus-control.js';
import { requireRuntimeEnv } from './runtime-env.js';

function formatSshProxyJumpLogin(input: {
  username: string;
  containerName: string;
  serverSlug?: string | null;
}): string {
  const username = input.username.trim().toLowerCase();
  const containerName = input.containerName.trim().toLowerCase();
  const serverSlug = input.serverSlug?.trim().toLowerCase() || null;
  return serverSlug
    ? `${username}.${serverSlug}.${containerName}`
    : `${username}.${containerName}`;
}

export function sshProxyJumpConfigured(): boolean {
  return Boolean(process.env.E2E_SSH_PROXY_HOST?.trim());
}

export async function runViaSshProxyJump(input: {
  username: string;
  containerName: string;
  serverSlug?: string | null;
  loginUser: string;
  routedIp: string;
  command: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const jumpLogin = formatSshProxyJumpLogin({
    username: input.username,
    containerName: input.containerName,
    serverSlug: input.serverSlug,
  });
  const proxyHost = requireRuntimeEnv('E2E_SSH_PROXY_HOST');
  const proxyPort = process.env.E2E_SSH_PROXY_PORT?.trim() || '2222';
  const identityFile = requireRuntimeEnv('E2E_SSH_PRIVATE_KEY_FILE');

  // Command-line -o flags apply to the destination only; ProxyJump uses a
  // nested ssh that still consults ~/.ssh/known_hosts. Pin both hops via -F.
  const directory = await mkdtemp(join(tmpdir(), 'nyabase-e2e-ssh-jump-'));
  const configPath = join(directory, 'ssh_config');
  const config = [
    'Host e2e-ssh-proxy-jump',
    `  HostName ${proxyHost}`,
    `  Port ${proxyPort}`,
    `  User ${jumpLogin}`,
    `  IdentityFile ${identityFile}`,
    '  IdentitiesOnly yes',
    '  BatchMode yes',
    '  StrictHostKeyChecking no',
    '  UserKnownHostsFile /dev/null',
    '  GlobalKnownHostsFile /dev/null',
    'Host *',
    `  IdentityFile ${identityFile}`,
    '  IdentitiesOnly yes',
    '  BatchMode yes',
    '  StrictHostKeyChecking no',
    '  UserKnownHostsFile /dev/null',
    '  GlobalKnownHostsFile /dev/null',
    '',
  ].join('\n');
  await writeFile(configPath, config, { mode: 0o600 });
  try {
    // OpenSSH joins argv after the destination into one remote command string.
    // Keep `/bin/sh -lc '<script>'` as a single argv so -c receives the script.
    const remote = `/bin/sh -lc ${JSON.stringify(input.command)}`;
    return await runCommand('ssh', [
      '-F',
      configPath,
      '-o',
      'ConnectTimeout=15',
      '-J',
      'e2e-ssh-proxy-jump',
      `${input.loginUser}@${input.routedIp}`,
      remote,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
