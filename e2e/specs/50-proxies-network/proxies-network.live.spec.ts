import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { probeFromIndependentNetworkClient } from '../../support/independent-network-client.js';
import {
  cleanupContainerThroughProductApi,
  type AgentTaskView,
  type ContainerView,
} from '../../support/durable-api.js';
import { controlProviderFault } from '../../support/provider-fault-control.js';
import {
  assertContainerPing,
  assertContainerPingAndHttp,
  startContainerHttpServer,
  withProductNetworkLeasePool,
  workloadAddressHost,
} from '../../support/product-network.js';
import { currentRunId } from '../../support/runtime-env.js';
import { aggregateErrorWithDiagnostics } from '../../support/error-diagnostics.mjs';
import type { APIRequestContext } from '@playwright/test';

interface NetworkServerView {
  id: string;
  status: string;
  runtimeReady: boolean;
  quarantineCode: string | null;
  quarantineMessage: string | null;
}

interface CreatedFaultServer {
  server: NetworkServerView;
  agentToken: string;
}

interface NetworkServerListEntry {
  id: string;
  slug: string;
}

async function waitForNetworkServer(
  adminApi: APIRequestContext,
  serverId: string,
  description: string,
  accept: (server: NetworkServerView) => boolean,
  timeoutMs = 90_000,
): Promise<NetworkServerView> {
  const deadline = Date.now() + timeoutMs;
  let last: NetworkServerView | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<NetworkServerView>(
      await adminApi.get(`/api/admin/servers/${serverId}`),
    );
    if (accept(last)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Server ${serverId} did not reach ${description} within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

async function deleteFaultServer(adminApi: APIRequestContext, serverId: string): Promise<void> {
  const response = await adminApi.delete(`/api/admin/servers/${serverId}`);
  if (response.status() !== 404) {
    expect(response.status(), 'fault Server cleanup response body withheld').toBe(204);
  }
  expect((await adminApi.get(`/api/admin/servers/${serverId}`)).status()).toBe(404);
}

async function listAdminContainers(
  adminApi: APIRequestContext,
  serverId: string,
): Promise<ContainerView[]> {
  return expectJson<ContainerView[]>(
    await adminApi.get(`/api/admin/v2/containers?serverId=${encodeURIComponent(serverId)}`),
  );
}

async function runNetworkCleanupSteps(
  description: string,
  steps: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw aggregateErrorWithDiagnostics(description, errors);
}

test.describe('50 proxies and network', () => {
  test(
    'api.network.real-agent-duplicate-static-claim-is-rejected-and-cleaned',
    coverageCase(
      'network.macvlan.duplicate-claim-rejection',
      'api.network.real-agent-duplicate-static-claim-is-rejected-and-cleaned',
    ),
    async ({ adminApi, topologyProvider }) => {
      test.setTimeout(300_000);
      const runId = currentRunId();
      const slug = `${runId}-duplicate-claim`.slice(0, 64);
      let created: CreatedFaultServer | null = null;
      let faultServerId: string | null = null;
      let faultAttempted = false;
      let primaryFailure: { error: unknown } | null = null;
      try {
        created = await expectJson<CreatedFaultServer>(
          await adminApi.post('/api/admin/servers', {
            data: { name: `${runId} duplicate claim`, slug },
          }),
          201,
        );
        if (typeof created.server?.id === 'string' && created.server.id !== '') {
          // Capture the durable identity before any response-shape assertion can fail.
          faultServerId = created.server.id;
        }
        expect(created.server.id).not.toBe('');
        expect(created.agentToken).toMatch(/^[a-f0-9]{64}$/);

        faultAttempted = true;
        const injected = await controlProviderFault(topologyProvider, {
          fault: 'duplicateNetworkClaim',
          runId,
          action: 'inject',
          serverId: faultServerId!,
          agentToken: created.agentToken,
        });
        expect(injected.present).toBe(true);
        expect(injected.serviceActive).toBe(true);

        const quarantined = await waitForNetworkServer(
          adminApi,
          faultServerId!,
          'duplicate static-claim quarantine',
          (server) => server.status === 'agent_quarantined',
        );
        expect(quarantined.runtimeReady).toBe(false);
        expect(quarantined.quarantineCode).toBe('AGENT_INVENTORY_FAULT');
        expect(quarantined.quarantineMessage).toBe(
          `Agent static address ${injected.conflictingAddress} is already owned by another network identity`,
        );

        const probed = await controlProviderFault(topologyProvider, {
          fault: 'duplicateNetworkClaim',
          runId,
          action: 'probe',
          serverId: faultServerId!,
        });
        expect(probed).toEqual(
          expect.objectContaining({
            containerName: injected.containerName,
            conflictingAddress: injected.conflictingAddress,
            present: true,
            serviceActive: true,
          }),
        );
      } catch (error) {
        primaryFailure = { error };
      }

      let cleanupFailure: { error: unknown } | null = null;
      try {
        let discoveredIds: string[] = [];
        let discoveryFailure: { error: unknown } | null = null;
        try {
          const servers = await expectJson<NetworkServerListEntry[]>(
            await adminApi.get('/api/admin/servers'),
          );
          discoveredIds = servers
            .filter((server) => server.slug === slug)
            .map((server) => server.id);
        } catch (error) {
          discoveryFailure = { error };
        }
        const serverIds = [
          ...new Set([...(faultServerId ? [faultServerId] : []), ...discoveredIds]),
        ];
        const cleanupSteps: Array<() => Promise<void>> = [
          async () => {
            if (!faultAttempted || !faultServerId) return;
            const restored = await controlProviderFault(topologyProvider, {
              fault: 'duplicateNetworkClaim',
              runId,
              action: 'restore',
              serverId: faultServerId,
            });
            expect(restored.present).toBe(false);
            expect(restored.serviceActive).toBe(false);
          },
          ...serverIds.map((serverId) => async () => deleteFaultServer(adminApi, serverId)),
        ];
        if (discoveryFailure !== null)
          cleanupSteps.push(async () => {
            throw discoveryFailure.error;
          });
        await runNetworkCleanupSteps('duplicate claim fault cleanup failed', cleanupSteps);
      } catch (error) {
        cleanupFailure = { error };
      }
      if (primaryFailure !== null && cleanupFailure !== null) {
        throw aggregateErrorWithDiagnostics(
          'duplicate claim behavior and cleanup both failed',
          [primaryFailure.error, cleanupFailure.error],
        );
      }
      if (primaryFailure !== null) throw primaryFailure.error;
      if (cleanupFailure !== null) throw cleanupFailure.error;
    },
  );

  test(
    'api.network.offline-peer-inventory-fails-closed-before-container-allocation',
    coverageCase(
      'network.macvlan.unknown-inventory-fail-stop',
      'api.network.offline-peer-inventory-fails-closed-before-container-allocation',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(300_000);
      const runId = currentRunId();
      const target = seedState.servers.find((server) => server.key === 'node1');
      const peer = seedState.servers.find((server) => server.key === 'node2');
      expect(target, 'CPU E2E seed has no node1').toBeDefined();
      expect(peer, 'CPU E2E seed has no node2').toBeDefined();
      const targetReady = await waitForNetworkServer(
        adminApi,
        target!.serverId,
        'online target authoritative inventory',
        (server) => server.status === 'online' && server.runtimeReady,
      );
      expect(targetReady.quarantineCode).toBeNull();
      const targetRuntimeBefore = await controlProviderFault(topologyProvider, {
        fault: 'agentService',
        runId,
        nodeKey: 'node1',
        action: 'probe',
      });
      expect(targetRuntimeBefore.serviceActive).toBe(true);
      const baseline = await listAdminContainers(adminApi, target!.serverId);
      const baselineIds = new Set(baseline.map((container) => container.id));
      const baselineTasks = await expectJson<AgentTaskView[]>(
        await adminApi.get(
          `/api/admin/agent-tasks?serverId=${encodeURIComponent(target!.serverId)}&limit=100`,
        ),
      );
      const baselineTaskIds = baselineTasks.map((task) => task.id).sort();
      const attemptedName = `${runId}-inventory-fail-stop`.slice(0, 64);

      let faultAttempted = false;
      let primaryFailure: { error: unknown } | null = null;
      try {
        faultAttempted = true;
        const stopped = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId,
          nodeKey: 'node2',
          action: 'stop',
        });
        expect(stopped.serviceActive).toBe(false);
        const offline = await waitForNetworkServer(
          adminApi,
          peer!.serverId,
          'non-online inventory state',
          (server) => server.status !== 'online',
        );
        expect(offline.runtimeReady).toBe(false);
        const stillReady = await expectJson<NetworkServerView>(
          await adminApi.get(`/api/admin/servers/${target!.serverId}`),
        );
        expect(stillReady).toEqual(
          expect.objectContaining({
            status: 'online',
            runtimeReady: true,
            quarantineCode: null,
          }),
        );

        const rejected = await adminApi.post('/api/v2/containers', {
          data: {
            serverId: target!.serverId,
            imageId: seedState.image.id,
            name: attemptedName,
          },
        });
        expect(rejected.status(), 'unknown-inventory admission response body withheld').toBe(409);
        const body = (await rejected.json()) as { code?: unknown; message?: unknown };
        expect(body).toEqual(
          expect.objectContaining({
            code: 'NETWORK_INVENTORY_UNTRUSTED',
            message: 'A Server on the shared macvlan has no trusted authoritative inventory',
          }),
        );
        const after = await listAdminContainers(adminApi, target!.serverId);
        expect(after.map((container) => container.id).sort()).toEqual([...baselineIds].sort());
        expect(after.some((container) => container.name === attemptedName)).toBe(false);
        const afterTasks = await expectJson<AgentTaskView[]>(
          await adminApi.get(
            `/api/admin/agent-tasks?serverId=${encodeURIComponent(target!.serverId)}&limit=100`,
          ),
        );
        expect(afterTasks.map((task) => task.id).sort()).toEqual(baselineTaskIds);
        const physical = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId,
          nodeKey: 'node1',
          action: 'probe',
        });
        expect(physical.serviceActive).toBe(true);
        expect(physical.runtimeContainerIds).toEqual(targetRuntimeBefore.runtimeContainerIds);
      } catch (error) {
        primaryFailure = { error };
      }

      let cleanupFailure: { error: unknown } | null = null;
      try {
        await runNetworkCleanupSteps('unknown inventory fault restoration failed', [
          async () => {
            if (!faultAttempted) return;
            const started = await controlProviderFault(topologyProvider, {
              fault: 'agentService',
              runId,
              nodeKey: 'node2',
              action: 'start',
            });
            expect(started.serviceActive).toBe(true);
            await waitForNetworkServer(
              adminApi,
              peer!.serverId,
              'online authoritative inventory',
              (server) => server.status === 'online' && server.runtimeReady,
            );
          },
          async () => {
            const residual = (await listAdminContainers(adminApi, target!.serverId)).filter(
              (container) => !baselineIds.has(container.id) || container.name === attemptedName,
            );
            for (const container of residual) {
              await cleanupContainerThroughProductApi(adminApi, container.id, adminApi);
            }
            const finalIds = (await listAdminContainers(adminApi, target!.serverId))
              .map((container) => container.id)
              .sort();
            expect(finalIds).toEqual([...baselineIds].sort());
          },
        ]);
      } catch (error) {
        cleanupFailure = { error };
      }
      if (primaryFailure !== null && cleanupFailure !== null) {
        throw aggregateErrorWithDiagnostics(
          'unknown inventory fail-stop behavior and restoration both failed',
          [primaryFailure.error, cleanupFailure.error],
        );
      }
      if (primaryFailure !== null) throw primaryFailure.error;
      if (cleanupFailure !== null) throw cleanupFailure.error;
    },
  );

  test(
    'api.network.concurrent-product-address-claims-are-globally-unique',
    coverageCase(
      'network.macvlan.unique-address-claims',
      'api.network.concurrent-product-address-claims-are-globally-unique',
    ),
    async ({ adminApi, seedState }) => {
      test.setTimeout(720_000);
      await withProductNetworkLeasePool(
        { adminApi, seedState, label: 'network-unique' },
        async (pool, deadline) => {
          // A single owner is intentionally serialized per Server. Exercise
          // real cross-Server concurrency twice instead of racing the product
          // resource lock with two creates for the same owner/Server pair.
          const firstPair = await pool.createMany(['node1', 'node2'], deadline);
          const secondPair = await pool.createMany(['node1', 'node2'], deadline);
          const runtimes = [...firstPair, ...secondPair];
          const addresses = runtimes.map((runtime) => runtime.ip);
          expect(new Set(addresses).size).toBe(addresses.length);
          const prefixes = new Set(
            addresses.map((address) => address.split('.').slice(0, 3).join('.')),
          );
          const expectedPrefix = seedState.servers[0].outerIp.split('.').slice(0, 3).join('.');
          expect([...prefixes]).toEqual([expectedPrefix]);
          for (const runtime of runtimes) {
            expect(workloadAddressHost(runtime.ip)).toBeGreaterThanOrEqual(101);
            expect(runtime.task.serverId).toBe(runtime.server.serverId);
          }
        },
      );
    },
  );

  test(
    'api.network.same-node-product-workloads-pass-bidirectional-icmp-and-http',
    coverageCase(
      'network.macvlan.same-node-traffic',
      'api.network.same-node-product-workloads-pass-bidirectional-icmp-and-http',
    ),
    async ({ adminApi, adminSession, page, seedState }) => {
      test.setTimeout(720_000);
      await withProductNetworkLeasePool(
        { adminApi, seedState, label: 'network-same-node' },
        async (pool, deadline) => {
          // Same-owner creates on one Server are a serialized product
          // operation. Build both real workloads through that public contract,
          // then verify their data-plane traffic in both directions.
          const server = await pool.create('node1', deadline);
          const client = await pool.create('node1', deadline);
          const marker = `same-node-${currentRunId()}`;
          await startContainerHttpServer(
            adminApi,
            page,
            adminSession.accessToken,
            server,
            marker,
            deadline,
          );
          await assertContainerPingAndHttp(
            adminApi,
            page,
            adminSession.accessToken,
            client,
            server.ip,
            marker,
            deadline,
          );
          await assertContainerPing(
            adminApi,
            page,
            adminSession.accessToken,
            server,
            client.ip,
            deadline,
          );
        },
      );
    },
  );

  test(
    'api.network.cross-node-product-workloads-pass-bidirectional-icmp-and-http',
    coverageCase(
      'network.macvlan.cross-node-ping-and-http',
      'api.network.cross-node-product-workloads-pass-bidirectional-icmp-and-http',
    ),
    async ({ adminApi, adminSession, page, seedState }) => {
      test.setTimeout(720_000);
      await withProductNetworkLeasePool(
        { adminApi, seedState, label: 'network-cross-node' },
        async (pool, deadline) => {
          const [node1, node2] = await pool.createMany(['node1', 'node2'], deadline);
          const marker1 = `cross-node1-${currentRunId()}`;
          const marker2 = `cross-node2-${currentRunId()}`;
          await startContainerHttpServer(
            adminApi,
            page,
            adminSession.accessToken,
            node1,
            marker1,
            deadline,
          );
          await startContainerHttpServer(
            adminApi,
            page,
            adminSession.accessToken,
            node2,
            marker2,
            deadline,
          );
          await assertContainerPingAndHttp(
            adminApi,
            page,
            adminSession.accessToken,
            node1,
            node2.ip,
            marker2,
            deadline,
          );
          await assertContainerPingAndHttp(
            adminApi,
            page,
            adminSession.accessToken,
            node2,
            node1.ip,
            marker1,
            deadline,
          );
        },
      );
    },
  );

  test(
    'api.network.independent-provider-client-and-product-workload-are-bidirectionally-reachable',
    coverageCase(
      'network.macvlan.independent-client-reachability',
      'api.network.independent-provider-client-and-product-workload-are-bidirectionally-reachable',
    ),
    async ({ adminApi, adminSession, page, seedState, topologyProvider }) => {
      test.setTimeout(720_000);
      await withProductNetworkLeasePool(
        { adminApi, seedState, label: 'network-independent' },
        async (pool, deadline) => {
          const runtime = await pool.create('node2', deadline);
          const workloadMarker = `independent-target-${currentRunId()}`;
          await startContainerHttpServer(
            adminApi,
            page,
            adminSession.accessToken,
            runtime,
            workloadMarker,
            deadline,
          );
          const probe = await probeFromIndependentNetworkClient(
            topologyProvider,
            runtime.ip,
            workloadMarker,
          );
          expect(probe.protocols).toEqual({ icmp: 'passed', http: 'passed' });
          await assertContainerPingAndHttp(
            adminApi,
            page,
            adminSession.accessToken,
            runtime,
            probe.sourceIp,
            `nyabase-independent-${currentRunId()}`,
            deadline,
          );
        },
      );
    },
  );

  test(
    'api.network.deleted-address-is-not-reused-before-the-proxy-drain-barrier',
    coverageCase(
      'network.macvlan.claim-reuse-delay',
      'api.network.deleted-address-is-not-reused-before-the-proxy-drain-barrier',
    ),
    async ({ adminApi, seedState }) => {
      test.setTimeout(720_000);
      await withProductNetworkLeasePool(
        { adminApi, seedState, label: 'network-reuse-delay' },
        async (pool, deadline) => {
          const first = await pool.create('node1', deadline);
          const deletion = await pool.delete(first, deadline);
          expect(deletion.kind).toBe('container.delete');
          const deletedAt = Date.parse(deletion.completedAt ?? '');
          expect(Number.isNaN(deletedAt)).toBe(false);
          const second = await pool.create('node1', deadline);
          const elapsedMs = Date.now() - deletedAt;
          expect(elapsedMs).toBeLessThan(360_000);
          expect(second.ip).not.toBe(first.ip);
          expect(workloadAddressHost(second.ip)).toBeGreaterThanOrEqual(101);
        },
      );
    },
  );

});
