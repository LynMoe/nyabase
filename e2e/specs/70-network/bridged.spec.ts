import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import {
  runCommand,
  runIncus,
} from '../../support/incus-control.js';
import { eventually } from '../../support/poll.js';
import { requireRuntimeEnv } from '../../support/runtime-env.js';

test(
  'verifies bridged LAN parent, guest address, host ping, and nft anti-spoof',
  { ...coverageCase('bridged-lan-cleanup', 'bridged-network-cleanup-live') },
  async ({ adminApi, seedState }) => {
    const parent = requireRuntimeEnv('E2E_INCUS_PARENT_INTERFACE');
    const link = await runCommand('ip', ['-d', 'link', 'show', 'dev', parent]);
    expect(link.code, link.stderr).toBe(0);
    expect(link.stdout).toMatch(/\bbridge\b/);

    const brif = await runCommand('bridge', ['link']);
    expect(brif.code, brif.stderr).toBe(0);
    expect(brif.stdout).toMatch(new RegExp(`master\\s+${parent}\\b`));

    const gateway = requireRuntimeEnv('E2E_INCUS_ROUTED_GATEWAY');
    const route = await runCommand('ip', ['route', 'get', gateway]);
    expect(route.code, route.stderr).toBe(0);

    if (process.env.E2E_ENABLE_NETWORK_MUTATION !== '1') {
      throw new Error(
        'BLOCKED: set E2E_ENABLE_NETWORK_MUTATION=1 after preflight to run the bridged probe',
      );
    }

    const name = `e2e-${seedState.runId}-bridged`;
    const address = requireRuntimeEnv('E2E_INCUS_ROUTED_ADDRESS');
    const spoof = requireRuntimeEnv('E2E_INCUS_SPOOF_ADDRESS');
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
        'nictype=bridged',
        `parent=${parent}`,
        'name=eth0',
        `ipv4.address=${address}`,
        'security.ipv4_filtering=true',
        'security.mac_filtering=true',
      ]);
      expect(configured.code, configured.stderr).toBe(0);

      const nictype = await runIncus(['config', 'device', 'get', name, 'eth0', 'nictype']);
      expect(nictype.code, nictype.stderr).toBe(0);
      expect(nictype.stdout.trim()).toBe('bridged');
      const filtering = await runIncus([
        'config',
        'device',
        'get',
        name,
        'eth0',
        'security.ipv4_filtering',
      ]);
      expect(filtering.stdout.trim()).toBe('true');

      const started = await runIncus(['start', name]);
      expect(started.code, started.stderr).toBe(0);

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

      const hostPing = await eventually(
        async () => runCommand('ping', ['-c', '1', '-W', '2', address]),
        (result) => result.code === 0,
        30_000,
        1_000,
        `host ping ${address}`,
      );
      expect(hostPing.code, hostPing.stderr).toBe(0);
      const gatewayPing = await eventually(
        async () => runIncus([
          'exec',
          name,
          '--',
          'ping',
          '-c',
          '1',
          '-W',
          '2',
          gateway,
        ]),
        (result) => result.code === 0,
        30_000,
        1_000,
        `guest ping ${gateway}`,
      );
      expect(gatewayPing.code, gatewayPing.stderr).toBe(0);

      const nft = await runCommand('nft', ['list', 'table', 'bridge', 'incus']);
      expect(nft.code, nft.stderr).toBe(0);
      expect(nft.stdout).toMatch(/arp\s+saddr\s+ip/);
      expect(nft.stdout).toMatch(/\bip\s+saddr\b/);
      expect(nft.stdout).toContain(address);

      const spoofed = await runIncus([
        'exec',
        name,
        '--',
        '/bin/sh',
        '-lc',
        [
          `ip addr add ${spoof}/32 dev eth0 || true`,
          `ping -I ${spoof} -c 1 -W 2 ${gateway}; echo spoof_ping=$?`,
        ].join('; '),
      ]);
      expect(spoofed.stdout).toMatch(/spoof_ping=[1-9]/);
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
    expect(bound?.id).toBeTruthy();
    await expectJson(await adminApi.get(`/api/admin/ip-pools/${bound!.id}`));
    const createdPool = await adminApi.post('/api/admin/ip-pools', { data: {} });
    expect(createdPool.status()).toBeGreaterThanOrEqual(400);
    const throwawayCidr = '10.254.251.0/24';
    const throwaway = await expectJson<Record<string, any>>(
      await adminApi.post('/api/admin/ip-pools', {
        data: {
          name: `e2e-ip-${seedState.runId}`.slice(0, 63),
          cidr: throwawayCidr,
          allocationCidr: throwawayCidr,
          gateway: '10.254.251.1',
          reservedIps: ['10.254.251.2'],
          serverIds: [],
        },
      }),
      [200, 201],
    );
    expect(throwaway.cidr).toBe(throwawayCidr);
    const dropped = await adminApi.delete(`/api/admin/ip-pools/${throwaway.id}`);
    expect([200, 204]).toContain(dropped.status());
    const missingPool = '00000000-0000-4000-8000-0000000000ff';
    const patchedPool = await adminApi.patch(`/api/admin/ip-pools/${missingPool}`, {
      data: { expectedRevision: 1, name: 'e2e-missing' },
    });
    expect(patchedPool.status()).toBeGreaterThanOrEqual(400);
    const deletedPool = await adminApi.delete(`/api/admin/ip-pools/${missingPool}`);
    expect(deletedPool.status()).toBeGreaterThanOrEqual(400);
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
