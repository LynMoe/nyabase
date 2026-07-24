import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { requireRuntimeEnv } from '../../support/runtime-env.js';
import {
  topologyCapabilities,
  type TopologyCapability,
  type TopologyCapabilityState,
} from '../../topology/provider.js';

const expectedCapabilityStates = {
  'fresh-control-plane': 'available',
  'tls-edge': 'available',
  'victoria-metrics': 'available',
  'local-tls-registry': 'available',
  'two-cpu-nodes': 'available',
  'real-systemd': 'available',
  'agent-managed-dockerd': 'available',
  'cgroup-v2': 'available',
  'xfs-project-quota': 'available',
  'mount-namespaces': 'available',
  'network-namespaces': 'available',
  'shared-macvlan-l2': 'available',
  'nfs-fixture': 'available',
  'cephfs-fixture': 'available',
  'ssh-proxy': 'available',
  'http-proxy': 'available',
  'agent-inventory-faults': 'available',
  'fault-injection': 'available',
  'physical-nic': 'unavailable',
  'physical-switch': 'unavailable',
  'bare-metal-boot': 'unavailable',
  'kernel-matrix': 'unavailable',
} as const satisfies Record<TopologyCapability, TopologyCapabilityState>;

async function inspectTlsEdge(): Promise<{
  authorized: boolean;
  protocol: string | null;
  peerSpki: string;
  validTo: string;
}> {
  const baseUrl = new URL(requireRuntimeEnv('E2E_BASE_URL'));
  const runtimeRoot = requireRuntimeEnv('E2E_RUNTIME_ROOT');
  const ca = readFileSync(join(runtimeRoot, 'certs', 'ca.crt'));

  return new Promise((resolve, reject) => {
    const socket = connectTls({
      host: baseUrl.hostname,
      port: Number(baseUrl.port || 443),
      servername: baseUrl.hostname,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ca,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
    };
    socket.setTimeout(10_000, () => finish(new Error('TLS edge handshake timed out')));
    socket.once('error', (error) => finish(error));
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(true);
      if (!peer.pubkey)
        return finish(new Error('TLS edge certificate did not expose its public key'));
      settled = true;
      const result = {
        authorized: socket.authorized,
        protocol: socket.getProtocol(),
        peerSpki: createHash('sha256').update(peer.pubkey).digest('base64'),
        validTo: peer.valid_to,
      };
      socket.end();
      resolve(result);
    });
  });
}

async function expectUnknownWebSocketRejected(): Promise<void> {
  const socketUrl = new URL('/ws/nyabase-e2e-unknown', requireRuntimeEnv('E2E_BASE_URL'));
  socketUrl.protocol = 'wss:';

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    let opened = false;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error('unknown WebSocket upgrade was not rejected within 10 seconds'));
    }, 10_000);
    const pass = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      expect(opened, 'an unknown WebSocket path must never reach OPEN').toBe(false);
      resolve();
    };
    socket.addEventListener(
      'open',
      () => {
        if (settled) return;
        settled = true;
        opened = true;
        clearTimeout(timeout);
        socket.close();
        reject(new Error('unknown WebSocket upgrade unexpectedly opened'));
      },
      { once: true },
    );
    socket.addEventListener('error', pass, { once: true });
    socket.addEventListener('close', pass, { once: true });
  });
}

test.describe('00 foundation', () => {
  test(
    'evidence.foundation.docker-dind-provider-boundary-is-explicit @smoke',
    coverageCase(
      'foundation.runtime.provider-boundary-contract',
      'evidence.foundation.docker-dind-provider-boundary-is-explicit',
    ),
    async ({ topologyProvider }) => {
      expect(topologyProvider.id).toBe('docker-dind');
      expect(topologyProvider.implementation).toBe('available');
      expect(topologyProvider.evidenceBoundary).toBe('shared-host-kernel');
      expect(topologyProvider.nodeCount).toBe(2);

      expect(topologyCapabilities).toHaveLength(22);
      expect(Object.keys(topologyProvider.capabilities).sort()).toEqual(
        [...topologyCapabilities].sort(),
      );
      expect(
        Object.fromEntries(
          topologyCapabilities.map((capability) => [
            capability,
            topologyProvider.capabilities[capability].state,
          ]),
        ),
      ).toEqual(expectedCapabilityStates);

      for (const capability of topologyCapabilities) {
        expect(topologyProvider.capabilities[capability].detail).not.toBe('');
      }
      expect(topologyProvider.capabilities['nfs-fixture'].state).toBe('available');
      expect(topologyProvider.capabilities['cephfs-fixture'].state).toBe('available');
      expect(topologyProvider.capabilities['ssh-proxy'].state).toBe('available');
      expect(topologyProvider.capabilities['http-proxy'].state).toBe('available');
    },
  );

  test(
    'api.foundation.public-settings.reachable @smoke',
    coverageCase(
      'foundation.runtime.public-settings-through-tls-edge',
      'api.foundation.public-settings.reachable',
    ),
    async ({ anonymousApi }) => {
      const baseUrl = new URL(requireRuntimeEnv('E2E_BASE_URL'));
      expect(baseUrl.protocol, 'the real E2E edge must use TLS').toBe('https:');

      const response = await anonymousApi.get('/api/public/settings');
      const settings = await expectJson<Record<string, unknown>>(response);
      expect(settings).toEqual(expect.any(Object));
      expect(Object.keys(settings).length).toBeGreaterThan(0);
    },
  );

  test(
    'api.foundation.health.live-unauthenticated @smoke',
    coverageCase(
      'foundation.runtime.http.get.api-health-live',
      'api.foundation.health.live-unauthenticated',
    ),
    async ({ anonymousApi }) => {
      const response = await anonymousApi.get('/api/health/live');
      const health = await expectJson(response);
      expect(health).toEqual({ status: 'ok' });
    },
  );

  test(
    'api.foundation.health.ready-unauthenticated @smoke',
    coverageCase(
      'foundation.runtime.http.get.api-health-ready',
      'api.foundation.health.ready-unauthenticated',
    ),
    async ({ anonymousApi }) => {
      const response = await anonymousApi.get('/api/health/ready');
      const health = await expectJson(response);
      expect(health).toEqual({ status: 'ok', database: 'ok' });
    },
  );

  test(
    'browser.foundation.frontend-served-by-live-edge @smoke',
    coverageCase(
      'foundation.runtime.frontend-login-through-tls-edge',
      'browser.foundation.frontend-served-by-live-edge',
    ),
    async ({ page }) => {
      const response = await page.goto('/login');
      expect(response?.status()).toBe(200);
      await expect(page.getByLabel('用户名')).toBeVisible();
      await expect(page.getByLabel('密码')).toBeVisible();
      await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
    },
  );

  test(
    'evidence.foundation.tls-edge-validates-run-ca-and-spki',
    coverageCase(
      'foundation.runtime.tls-edge',
      'evidence.foundation.tls-edge-validates-run-ca-and-spki',
    ),
    async () => {
      const observed = await inspectTlsEdge();
      expect(observed.authorized).toBe(true);
      expect(['TLSv1.2', 'TLSv1.3']).toContain(observed.protocol);
      expect(observed.peerSpki).toBe(requireRuntimeEnv('E2E_EDGE_SPKI'));
      expect(Date.parse(observed.validTo)).toBeGreaterThan(Date.now());
    },
  );

  test(
    'security.foundation.unknown-websocket-path-is-rejected',
    coverageCase(
      'foundation.runtime.unknown-websocket-rejection',
      'security.foundation.unknown-websocket-path-is-rejected',
    ),
    async () => {
      await expectUnknownWebSocketRejected();
    },
  );
});
