import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireProcessGuard } from './process-guard.js';

const children = new Set<ChildProcess>();

afterEach(async () => {
  await Promise.all(Array.from(children).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await once(child, 'exit').catch(() => undefined);
  }));
  children.clear();
});

describe('acquireProcessGuard', () => {
  it('atomically rejects a second Agent for the same server', async () => {
    const serverId = `guard-${randomUUID()}`;
    const first = await acquireProcessGuard(serverId);
    try {
      await expect(acquireProcessGuard(serverId)).rejects.toThrow('already owns');
    } finally {
      await first.release();
    }
  });

  it('also rejects a differently configured serverId on the same host', async () => {
    const first = await acquireProcessGuard(`guard-a-${randomUUID()}`);
    try {
      await expect(acquireProcessGuard(`guard-b-${randomUUID()}`)).rejects.toThrow('already owns');
    } finally {
      await first.release();
    }
  });

  it('is released by the kernel after SIGKILL with no stale lock cleanup', async () => {
    const serverId = `guard-${randomUUID()}`;
    const script = String.raw`
      const net = require('net');
      const server = net.createServer();
      server.listen('\0nyabase-agent-host-global-v1', () => process.stdout.write('ready\n'));
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script, serverId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    await waitForReady(child);
    child.kill('SIGKILL');
    await once(child, 'exit');
    children.delete(child);

    const guard = await acquireProcessGuard(serverId);
    await guard.release();
  });
});

async function waitForReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('child guard did not become ready')), 5_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`child exited early: ${code ?? signal}`)));
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!chunk.toString().includes('ready')) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}
