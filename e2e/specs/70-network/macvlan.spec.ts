import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import {
  runCommand,
  runIncus,
} from '../../support/incus-control.js';
import { requireRuntimeEnv } from '../../support/runtime-env.js';

test(
  'verifies macvlan parent, shared IP pool binding, and probe cleanup',
  { ...coverageCase('macvlan-lan-cleanup', 'macvlan-network-cleanup-live') },
  async ({ adminApi, seedState }) => {
    const parent = requireRuntimeEnv('E2E_INCUS_PARENT_INTERFACE');
    const link = await runCommand('ip', ['link', 'show', 'dev', parent]);
    expect(link.code, link.stderr).toBe(0);

    const gateway = requireRuntimeEnv('E2E_INCUS_ROUTED_GATEWAY');
    const route = await runCommand('ip', ['route', 'get', gateway]);
    expect(route.code, route.stderr).toBe(0);
    expect(route.stdout).toContain(parent);

    if (process.env.E2E_ENABLE_NETWORK_MUTATION !== '1') {
      throw new Error(
        'BLOCKED: set E2E_ENABLE_NETWORK_MUTATION=1 after preflight to run the macvlan probe',
      );
    }

    const name = `e2e-${seedState.runId}-macvlan`;
    let cleanupComplete = false;
    try {
      const initialized = await runIncus([
        'init',
        '--storage',
        requireRuntimeEnv('E2E_INCUS_DIR_POOL'),
        `${requireRuntimeEnv('E2E_INCUS_IMAGE_REMOTE')}:${requireRuntimeEnv('E2E_INCUS_IMAGE_ALIAS')}`,
        name,
      ]);
      expect(initialized.code, initialized.stderr).toBe(0);

      const configured = await runIncus([
        'config',
        'device',
        'add',
        name,
        'eth0',
        'nic',
        'nictype=macvlan',
        'mode=bridge',
        `parent=${parent}`,
        'name=eth0',
      ]);
      expect(configured.code, configured.stderr).toBe(0);

      const started = await runIncus(['start', name]);
      expect(started.code, started.stderr).toBe(0);

      const address = requireRuntimeEnv('E2E_INCUS_ROUTED_ADDRESS');
      const cidr = requireRuntimeEnv('E2E_INCUS_ROUTED_SUBNET');
      const prefix = cidr.split('/')[1] ?? '16';
      const applied = await runIncus([
        'exec',
        name,
        '--',
        '/bin/sh',
        '-lc',
        [
          'set -euo pipefail',
          'ip link set eth0 up',
          `ip addr replace ${address}/${prefix} dev eth0`,
          `ip route replace default via ${gateway} dev eth0`,
          `ip -4 addr show dev eth0 | grep -F ${address}`,
        ].join('; '),
      ]);
      expect(applied.code, applied.stderr).toBe(0);
      expect(applied.stdout).toContain(address);

      const pingGw = await runIncus([
        'exec',
        name,
        '--',
        'ping',
        '-c',
        '1',
        '-W',
        '3',
        gateway,
      ]);
      expect(pingGw.code, pingGw.stderr).toBe(0);
    } finally {
      const deleted = await runIncus(['delete', '--force', name]);
      cleanupComplete = deleted.code === 0 || /not found/i.test(deleted.stderr);
    }
    expect(cleanupComplete).toBe(true);

    const server = await expectJson<Record<string, any>>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}`),
    );
    expect(server.parentInterface).toBe(parent);
    const pools = await expectJson<Array<Record<string, any>>>(
      await adminApi.get('/api/admin/ip-pools'),
    );
    const bound = pools.find((pool) =>
      pool.id === seedState.server.ipPoolId
      || (pool.cidr === seedState.server.routedSubnet
        && Array.isArray(pool.serverIds)
        && pool.serverIds.includes(seedState.server.id)));
    expect(bound?.cidr).toBe(seedState.server.routedSubnet);
    expect(bound?.serverIds ?? []).toContain(seedState.server.id);
    await expectJson<Record<string, unknown>>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}/storage-capacity`),
    );

    const instances = await runIncus(['list', '--format', 'json']);
    expect(instances.code, instances.stderr).toBe(0);
    const remaining = JSON.parse(instances.stdout) as Array<{ name?: string }>;
    expect(remaining.some((entry) => entry.name?.startsWith(`e2e-${seedState.runId}`)))
      .toBe(false);
  },
);
