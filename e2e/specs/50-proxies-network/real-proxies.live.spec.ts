import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import {
  cleanupContainerThroughProductApi,
  waitForAgentTask,
  waitForContainer,
  type AgentTaskRef,
} from '../../support/durable-api.js';
import { expectJson, expectSuccess } from '../../support/http.js';
import { aggregateErrorWithDiagnostics } from '../../support/error-diagnostics.mjs';
import { controlProxyClient } from '../../support/proxy-client-control.js';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';

interface ProxyStatus {
  connectedProxies: number;
  activeConnections: number;
  proxies: Array<{ lastSnapshotGeneration: number | null; activeConnections: number }>;
}

interface HostKeyView {
  fingerprint: string;
  generation: number;
  rotatedAt: string;
}

interface DomainPoolView {
  id: string;
  wildcardDomain: string;
  enabled: boolean;
  httpsEnabled: boolean;
}

interface BindingView {
  id: string;
  mine: boolean;
  ownerId: string;
  hostname: string;
  domainPoolId: string;
  containerId: string;
  targetPort: number;
  status: string;
  warningReasons: string[];
}

interface UserView {
  id: string;
  username: string;
  status: string;
}

let targetContainerId: string | null = null;
let targetContainerName = '';
let externalKeyId: string | null = null;
let initialHostKey: HostKeyView | null = null;
let primaryPoolId: string | null = null;
let primaryBindingId: string | null = null;
let exactBindingId: string | null = null;
const proxyAttemptId = `${process.pid}-${Date.now().toString(36)}`;
const primaryHostname = `app-${proxyAttemptId}.e2e.test`;
const exactHostname = `exact-${proxyAttemptId}.e2e.test`;

async function waitForProxyStatus(
  api: APIRequestContext,
  path: '/api/admin/ssh-proxy/status' | '/api/admin/http-proxy/status',
  accept: (status: ProxyStatus) => boolean,
  timeoutMs = 60_000,
): Promise<ProxyStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: ProxyStatus | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<ProxyStatus>(await api.get(path));
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Proxy status ${path} did not converge; last=${JSON.stringify(last)}`);
}

async function waitForHostFingerprint(
  topologyProvider: Parameters<typeof controlProxyClient>[0],
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let observed: string | null = null;
  while (Date.now() < deadline) {
    const probe = await controlProxyClient(topologyProvider, {
      runId: currentRunId(),
      action: 'sshHostKey',
    });
    observed = probe.hostKeyFingerprint;
    if (observed === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`SSH proxy host fingerprint did not converge to ${expected}; observed=${observed}`);
}

async function waitForHttpStatus(
  topologyProvider: Parameters<typeof controlProxyClient>[0],
  hostname: string,
  marker: string,
  expectedStatus: number,
): Promise<Awaited<ReturnType<typeof controlProxyClient>>> {
  const deadline = Date.now() + 60_000;
  let last: Awaited<ReturnType<typeof controlProxyClient>> | null = null;
  while (Date.now() < deadline) {
    last = await controlProxyClient(topologyProvider, {
      runId: currentRunId(), action: 'httpGet', hostname, marker,
    });
    if (last.httpStatus === expectedStatus) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`HTTP proxy ${hostname} did not reach ${expectedStatus}; last=${JSON.stringify(last)}`);
}

async function deleteUser(adminApi: APIRequestContext, userId: string): Promise<void> {
  const response = await adminApi.delete(`/api/admin/users/${userId}`);
  if (response.status() === 404) return;
  const result = await expectJson<{ deleted: boolean; taskIds: string[] }>(response);
  for (const taskId of result.taskIds) await waitForAgentTask(adminApi, taskId);
}

async function deleteIfPresent(adminApi: APIRequestContext, path: string): Promise<void> {
  const response = await adminApi.delete(path);
  if (response.status() === 404) return;
  await expectSuccess(response);
}

async function cleanupSharedProxyResources(
  adminApi: APIRequestContext,
  adminUserId: string,
  topologyProvider: Parameters<typeof controlProxyClient>[0],
): Promise<void> {
  const failures: Error[] = [];
  const attempt = async (cleanup: () => Promise<void>): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  };

  await attempt(async () => {
    await controlProxyClient(topologyProvider, {
      runId: currentRunId(), action: 'sshHoldRelease',
    });
  });
  if (primaryBindingId) {
    const id = primaryBindingId;
    await attempt(async () => deleteIfPresent(adminApi, `/api/v2/http-proxy/bindings/${id}`));
    primaryBindingId = null;
  }
  if (exactBindingId) {
    const id = exactBindingId;
    await attempt(async () => deleteIfPresent(adminApi, `/api/v2/http-proxy/bindings/${id}`));
    exactBindingId = null;
  }
  if (primaryPoolId) {
    const id = primaryPoolId;
    await attempt(async () => deleteIfPresent(
      adminApi,
      `/api/admin/http-proxy/domain-pools/${id}`,
    ));
    primaryPoolId = null;
  }
  if (targetContainerId) {
    const id = targetContainerId;
    await attempt(async () => {
      await cleanupContainerThroughProductApi(adminApi, id);
    });
    targetContainerId = null;
  }
  if (externalKeyId) {
    const id = externalKeyId;
    await attempt(async () => deleteIfPresent(
      adminApi,
      `/api/users/${adminUserId}/ssh-keys/${id}`,
    ));
    externalKeyId = null;
  }

  if (failures.length > 0) {
    throw aggregateErrorWithDiagnostics(
      'Failed to clean shared real-proxy test resources',
      failures,
    );
  }
}

test.describe.serial('50 real SSH and HTTP proxies', () => {
  test.afterEach(async ({ adminApi, adminSession, topologyProvider }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await cleanupSharedProxyResources(adminApi, adminSession.user.id, topologyProvider);
    }
  });

  test(
    'api.proxies.ssh-online-and-real-host-key',
    coverageCase(
      'proxies.ssh-http.ssh-proxy-online-and-host-key',
      'api.proxies.ssh-online-and-real-host-key',
    ),
    async ({ adminApi, adminSession, seedState, topologyProvider }) => {
      test.setTimeout(300_000);
      const server = seedState.servers.find((entry) => entry.key === 'node1');
      expect(server).toBeDefined();
      expect(seedState.proxyImage).toBeDefined();
      targetContainerName = `${currentRunId().slice(0, 38)}-proxy-target`.slice(0, 64);
      const created = await expectJson<AgentTaskRef>(
        await adminApi.post('/api/v2/containers', {
          data: {
            serverId: server!.serverId,
            imageId: seedState.proxyImage!.id,
            name: targetContainerName,
          },
        }),
        201,
      );
      const pending = await expectJson<{ resourceId: string }>(
        await adminApi.get(`/api/admin/agent-tasks/${created.taskId}`),
      );
      targetContainerId = pending.resourceId;
      await waitForAgentTask(adminApi, created.taskId, {
        kind: 'container.create', resourceId: targetContainerId, timeoutMs: 180_000,
      });
      const running = await waitForContainer(
        adminApi,
        targetContainerId,
        'running with real Agent-injected SSH',
        (view) => view.runtime.status === 'running' && view.ssh.ready === true && view.activeTask === null,
        180_000,
      );
      expect(running.runtime.ip).toMatch(/^172\.29\./);
      expect(running.ssh.proxyHost).toMatch(/^172\.29\./);
      expect(running.ssh.proxyPort).toBe(2222);

      const publicKey = readFileSync(
        join(requireRuntimeEnv('E2E_RUNTIME_ROOT'), 'proxies', 'external-key.pub'),
        'utf8',
      ).trim();
      const key = await expectJson<{ id: string; name: string; keyText: string }>(
        await adminApi.post(`/api/users/${adminSession.user.id}/ssh-keys`, {
          data: { name: `${currentRunId()} external proxy key`, keyText: publicKey },
        }),
        201,
      );
      externalKeyId = key.id;
      expect(key.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(key.name).toBe(`${currentRunId()} external proxy key`);
      expect(key.keyText).toBe(publicKey.split(/\s+/).slice(0, 2).join(' '));

      const status = await waitForProxyStatus(
        adminApi,
        '/api/admin/ssh-proxy/status',
        (value) => value.connectedProxies === 1 && value.proxies[0]?.lastSnapshotGeneration !== null,
      );
      expect(status.connectedProxies).toBe(1);
      initialHostKey = await expectJson<HostKeyView>(
        await adminApi.get('/api/admin/ssh-proxy/host-key'),
      );
      const scan = await controlProxyClient(topologyProvider, {
        runId: currentRunId(), action: 'sshHostKey',
      });
      expect(scan.hostKeyFingerprint).toBe(initialHostKey.fingerprint);
      expect(scan.defaultSendEnv).toEqual(expect.arrayContaining(['LANG', 'LC_*']));
    },
  );

  test(
    'network.proxies.real-default-openssh-command-and-sftp',
    coverageCase(
      'proxies.ssh-http.real-ssh-command-and-sftp',
      'network.proxies.real-default-openssh-command-and-sftp',
    ),
    async ({ topologyProvider }) => {
      expect(targetContainerId).not.toBeNull();
      const ssh = await controlProxyClient(topologyProvider, {
        runId: currentRunId(), action: 'sshExec', nodeKey: 'node1',
        containerName: targetContainerName, marker: 'nyabase-real-ssh',
      });
      expect(ssh.markerMatched).toBe(true);
      expect(ssh.defaultSendEnv).toEqual(expect.arrayContaining(['LANG', 'LC_*']));
      const sftp = await controlProxyClient(topologyProvider, {
        runId: currentRunId(), action: 'sftpRoundTrip', nodeKey: 'node1',
        containerName: targetContainerName, marker: 'nyabase-real-sftp',
      });
      expect(sftp.markerMatched).toBe(true);
      expect(sftp.sftpBytes).toBe(Buffer.byteLength('nyabase-real-sftp\n'));
      expect(sftp.sftpSha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  test(
    'api.proxies.ssh-host-key-rotation-reaches-real-listener',
    coverageCase(
      'proxies.ssh-http.host-key-rotation',
      'api.proxies.ssh-host-key-rotation-reaches-real-listener',
    ),
    async ({ adminApi, topologyProvider }) => {
      expect(initialHostKey).not.toBeNull();
      const rotated = await expectJson<HostKeyView>(
        await adminApi.post('/api/admin/ssh-proxy/host-key/rotate'),
      );
      expect(rotated.generation).toBeGreaterThan(initialHostKey!.generation);
      expect(rotated.fingerprint).not.toBe(initialHostKey!.fingerprint);
      await waitForHostFingerprint(topologyProvider, rotated.fingerprint);
    },
  );

  test(
    'api.proxies.disconnect-all-closes-an-established-real-ssh-session',
    coverageCase(
      'proxies.ssh-http.disconnect-behavior',
      'api.proxies.disconnect-all-closes-an-established-real-ssh-session',
    ),
    async ({ adminApi, topologyProvider }) => {
      try {
        const held = await controlProxyClient(topologyProvider, {
          runId: currentRunId(), action: 'sshHoldStart', nodeKey: 'node1',
          containerName: targetContainerName, marker: 'ssh-hold-ready',
        });
        expect(held.holdAlive).toBe(true);
        await waitForProxyStatus(
          adminApi,
          '/api/admin/ssh-proxy/status',
          (value) => value.activeConnections >= 1,
        );
        const disconnected = await expectJson<{
          requestId: string; requested: number; disconnected: number;
        }>(await adminApi.post('/api/admin/ssh-proxy/disconnect-all'));
        expect(disconnected.requested).toBeGreaterThanOrEqual(1);
        expect(disconnected.disconnected).toBeGreaterThanOrEqual(1);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const probe = await controlProxyClient(topologyProvider, {
            runId: currentRunId(), action: 'sshHoldProbe',
          });
          if (probe.holdAlive === false) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect((await controlProxyClient(topologyProvider, {
          runId: currentRunId(), action: 'sshHoldProbe',
        })).holdAlive).toBe(false);
        await waitForProxyStatus(
          adminApi,
          '/api/admin/ssh-proxy/status',
          (value) => value.activeConnections === 0,
        );
      } finally {
        await controlProxyClient(topologyProvider, {
          runId: currentRunId(), action: 'sshHoldRelease',
        });
      }
    },
  );

  test(
    'api.proxies.real-gateway-status-readable',
    coverageCase(
      'proxies.ssh-http.gateway-status-readable',
      'api.proxies.real-gateway-status-readable',
    ),
    async ({ adminApi }) => {
      const ssh = await expectJson<ProxyStatus>(await adminApi.get('/api/admin/ssh-proxy/status'));
      const http = await expectJson<ProxyStatus>(await adminApi.get('/api/admin/http-proxy/status'));
      expect(ssh.connectedProxies).toBe(1);
      expect(http.connectedProxies).toBe(1);
    },
  );

  test(
    'api.proxies.http-domain-pool-full-lifecycle',
    coverageCase(
      'proxies.ssh-http.http-domain-pool-lifecycle',
      'api.proxies.http-domain-pool-full-lifecycle',
    ),
    async ({ adminApi }) => {
      const created = await expectJson<DomainPoolView>(
        await adminApi.post('/api/admin/http-proxy/domain-pools', {
          data: { wildcardDomain: '*.lifecycle.test', enabled: true, httpsEnabled: false },
        }),
        201,
      );
      expect(created.wildcardDomain).toBe('*.lifecycle.test');
      expect((await expectJson<DomainPoolView[]>(
        await adminApi.get('/api/admin/http-proxy/domain-pools'),
      )).some((pool) => pool.id === created.id)).toBe(true);
      const updated = await expectJson<DomainPoolView>(
        await adminApi.patch(`/api/admin/http-proxy/domain-pools/${created.id}`, {
          data: { enabled: false },
        }),
      );
      expect(updated.enabled).toBe(false);
      await expectSuccess(await adminApi.delete(`/api/admin/http-proxy/domain-pools/${created.id}`));
    },
  );

  test(
    'api.proxies.http.get-domain-pools-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.get.api-admin-http-proxy-domain-pools',
      'api.proxies.http.get-domain-pools-exact-contract',
    ),
    async ({ adminApi }) => {
      expect(
        await expectJson<DomainPoolView[]>(
          await adminApi.get('/api/admin/http-proxy/domain-pools'),
        ),
      ).toBeInstanceOf(Array);
    },
  );

  test(
    'api.proxies.http.post-domain-pool-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.post.api-admin-http-proxy-domain-pools',
      'api.proxies.http.post-domain-pool-exact-contract',
    ),
    async ({ adminApi }) => {
      const pool = await expectJson<DomainPoolView>(
        await adminApi.post('/api/admin/http-proxy/domain-pools', {
          data: { wildcardDomain: '*.e2e.test', enabled: true, httpsEnabled: false },
        }),
        201,
      );
      primaryPoolId = pool.id;
      expect(pool.wildcardDomain).toBe('*.e2e.test');
    },
  );

  test(
    'api.proxies.http.patch-domain-pool-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.patch.api-admin-http-proxy-domain-pools-by-id',
      'api.proxies.http.patch-domain-pool-exact-contract',
    ),
    async ({ adminApi }) => {
      expect(primaryPoolId).not.toBeNull();
      const pool = await expectJson<DomainPoolView>(
        await adminApi.patch(`/api/admin/http-proxy/domain-pools/${primaryPoolId}`, {
          data: { enabled: true },
        }),
      );
      expect(pool.enabled).toBe(true);
    },
  );

  test(
    'network.proxies.real-http-request-and-websocket-upgrade',
    coverageCase(
      'proxies.ssh-http.real-http-request-and-websocket-upgrade',
      'network.proxies.real-http-request-and-websocket-upgrade',
    ),
    async ({ adminApi, topologyProvider }) => {
      expect(targetContainerId).not.toBeNull();
      const binding = await expectJson<BindingView>(
        await adminApi.post('/api/v2/http-proxy/bindings', {
          data: { hostname: primaryHostname, containerId: targetContainerId, targetPort: 8080 },
        }),
        201,
      );
      primaryBindingId = binding.id;
      const http = await waitForHttpStatus(
        topologyProvider, primaryHostname, 'http-real', 200,
      );
      expect(http.markerMatched).toBe(true);
      const websocket = await controlProxyClient(topologyProvider, {
        runId: currentRunId(), action: 'websocketEcho',
        hostname: primaryHostname, marker: 'websocket-real',
      });
      expect(websocket.httpStatus).toBe(101);
      expect(websocket.markerMatched).toBe(true);
    },
  );

  test(
    'api.proxies.http-binding-owner-isolation-and-live-revocation',
    coverageCase(
      'proxies.ssh-http.binding-ownership-and-revocation',
      'api.proxies.http-binding-owner-isolation-and-live-revocation',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, topologyProvider }) => {
      expect(primaryBindingId).not.toBeNull();
      const username = `${currentRunId().replace(/-/g, '_').slice(0, 24)}_proxy_${proxyAttemptId.replace(/-/g, '_')}`.slice(0, 64);
      const password = `E2e-${currentRunId()}-Proxy!`;
      const other = await expectJson<UserView>(
        await adminApi.post('/api/admin/users', {
          data: { username, password, displayName: `${currentRunId()} proxy other` },
        }),
        201,
      );
      try {
        const session = await expectJson<{ accessToken: string }>(
          await anonymousApi.post('/api/auth/login', { data: { username, password } }),
        );
        const otherApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
        });
        expect(
          await expectJson<BindingView[]>(
            await otherApi.get('/api/v2/http-proxy/bindings'),
          ),
        ).toEqual([]);
        expect((await otherApi.patch(`/api/v2/http-proxy/bindings/${primaryBindingId}`, {
          data: { targetPort: 8080 },
        })).status()).toBe(403);
        expect((await otherApi.delete(
          `/api/v2/http-proxy/bindings/${primaryBindingId}`,
        )).status()).toBe(403);
        await expectSuccess(
          await adminApi.delete(`/api/v2/http-proxy/bindings/${primaryBindingId}`),
        );
        primaryBindingId = null;
        const revoked = await waitForHttpStatus(
          topologyProvider, primaryHostname, 'http-revoked', 404,
        );
        expect(revoked.markerMatched).toBe(false);
      } finally {
        await deleteUser(adminApi, other.id);
      }
    },
  );

  test(
    'api.proxies.http.get-bindings-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.get.api-v2-http-proxy-bindings',
      'api.proxies.http.get-bindings-exact-contract',
    ),
    async ({ adminApi }) => {
      expect(
        await expectJson<BindingView[]>(
          await adminApi.get('/api/v2/http-proxy/bindings'),
        ),
      ).toEqual([]);
    },
  );

  test(
    'api.proxies.http.post-binding-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.post.api-v2-http-proxy-bindings',
      'api.proxies.http.post-binding-exact-contract',
    ),
    async ({ adminApi }) => {
      const binding = await expectJson<BindingView>(
        await adminApi.post('/api/v2/http-proxy/bindings', {
          data: { hostname: exactHostname, containerId: targetContainerId, targetPort: 8080 },
        }),
        201,
      );
      exactBindingId = binding.id;
      expect(binding.hostname).toBe(exactHostname);
    },
  );

  test(
    'api.proxies.http.patch-binding-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.patch.api-v2-http-proxy-bindings-by-id',
      'api.proxies.http.patch-binding-exact-contract',
    ),
    async ({ adminApi }) => {
      expect(exactBindingId).not.toBeNull();
      const binding = await expectJson<BindingView>(
        await adminApi.patch(`/api/v2/http-proxy/bindings/${exactBindingId}`, {
          data: { targetPort: 8080 },
        }),
      );
      expect(binding.targetPort).toBe(8080);
    },
  );

  test(
    'api.proxies.http.delete-binding-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.delete.api-v2-http-proxy-bindings-by-id',
      'api.proxies.http.delete-binding-exact-contract',
    ),
    async ({ adminApi }) => {
      expect(exactBindingId).not.toBeNull();
      await expectSuccess(await adminApi.delete(`/api/v2/http-proxy/bindings/${exactBindingId}`));
      exactBindingId = null;
    },
  );

  test(
    'api.proxies.http.delete-domain-pool-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.delete.api-admin-http-proxy-domain-pools-by-id',
      'api.proxies.http.delete-domain-pool-exact-contract',
    ),
    async ({ adminApi }) => {
      expect(primaryPoolId).not.toBeNull();
      await expectSuccess(
        await adminApi.delete(`/api/admin/http-proxy/domain-pools/${primaryPoolId}`),
      );
      primaryPoolId = null;
    },
  );

  test(
    'api.proxies.http.get-status-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.get.api-admin-http-proxy-status',
      'api.proxies.http.get-status-exact-contract',
    ),
    async ({ adminApi }) => {
      const status = await expectJson<ProxyStatus>(
        await adminApi.get('/api/admin/http-proxy/status'),
      );
      expect(status.connectedProxies).toBe(1);
    },
  );

  test(
    'api.proxies.ssh.get-host-key-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.get.api-admin-ssh-proxy-host-key',
      'api.proxies.ssh.get-host-key-exact-contract',
    ),
    async ({ adminApi }) => {
      const hostKey = await expectJson<HostKeyView>(
        await adminApi.get('/api/admin/ssh-proxy/host-key'),
      );
      expect(hostKey.fingerprint).toMatch(/^SHA256:/);
    },
  );

  test(
    'api.proxies.ssh.get-status-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.get.api-admin-ssh-proxy-status',
      'api.proxies.ssh.get-status-exact-contract',
    ),
    async ({ adminApi }) => {
      const status = await expectJson<ProxyStatus>(
        await adminApi.get('/api/admin/ssh-proxy/status'),
      );
      expect(status.connectedProxies).toBe(1);
    },
  );

  test(
    'api.proxies.ssh.post-disconnect-all-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.post.api-admin-ssh-proxy-disconnect-all',
      'api.proxies.ssh.post-disconnect-all-exact-contract',
    ),
    async ({ adminApi }) => {
      const result = await expectJson<{ requestId: string; requested: number; disconnected: number }>(
        await adminApi.post('/api/admin/ssh-proxy/disconnect-all'),
      );
      expect(result.requestId).toMatch(/^[0-9a-f]{24}$/);
      expect(Number.isInteger(result.requested)).toBe(true);
      expect(Number.isInteger(result.disconnected)).toBe(true);
      expect(result.requested).toBeGreaterThanOrEqual(0);
      expect(result.disconnected).toBeGreaterThanOrEqual(0);
      expect(result.disconnected).toBeLessThanOrEqual(result.requested);
      await waitForProxyStatus(
        adminApi,
        '/api/admin/ssh-proxy/status',
        (value) => value.activeConnections === 0,
      );
    },
  );

  test(
    'api.proxies.ssh.post-host-key-rotate-exact-contract',
    coverageCase(
      'proxies.ssh-http.http.post.api-admin-ssh-proxy-host-key-rotate',
      'api.proxies.ssh.post-host-key-rotate-exact-contract',
    ),
    async ({ adminApi, adminSession, topologyProvider }) => {
      try {
        const before = await expectJson<HostKeyView>(
          await adminApi.get('/api/admin/ssh-proxy/host-key'),
        );
        const after = await expectJson<HostKeyView>(
          await adminApi.post('/api/admin/ssh-proxy/host-key/rotate'),
        );
        expect(after.generation).toBeGreaterThan(before.generation);
        await waitForHostFingerprint(topologyProvider, after.fingerprint);
      } finally {
        await cleanupSharedProxyResources(adminApi, adminSession.user.id, topologyProvider);
      }
    },
  );
});
