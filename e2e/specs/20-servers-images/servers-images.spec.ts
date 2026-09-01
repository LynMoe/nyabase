import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { eventually } from '../../support/poll.js';
import { requireRuntimeEnv } from '../../support/runtime-env.js';

type JsonRecord = Record<string, any>;

async function incusStatus(path: string): Promise<number> {
  const base = new URL(requireRuntimeEnv('E2E_INCUS_API_ENDPOINT'));
  const requestUrl = new URL(path, base);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(requestUrl, {
      method: 'GET',
      ca: readFileSync(requireRuntimeEnv('E2E_INCUS_CA_FILE')),
      cert: readFileSync(requireRuntimeEnv('E2E_INCUS_CLIENT_CERT')),
      key: readFileSync(requireRuntimeEnv('E2E_INCUS_CLIENT_KEY')),
      rejectUnauthorized: true,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 500));
    });
    request.once('error', reject);
    request.end();
  });
}

test(
  'uses the seeded Incus onboarding connection and runs preflight',
  { ...coverageCase('server-mtls-trust-onboarding', 'server-onboarding-live') },
  async ({ adminApi, seedState }) => {
    const server = await expectJson<JsonRecord>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}`),
    );
    expect(server.apiEndpoint ?? server.endpoint).toMatch(/^https:\/\//);
    expect(server.certificateFingerprint ?? server.serverCertFingerprint)
      .toBe(seedState.server.certificateFingerprint);
    expect(server.status).toBe('online');
    // Intent list max page is 100 and live runs accumulate many server-scoped rows.
    // Page until a succeeded server.connect proof is visible (kind query is not supported).
    let connectIntent: JsonRecord | undefined;
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 20 && !connectIntent; pageIndex += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const intentPage = await expectJson<{ items: JsonRecord[]; nextCursor?: string | null }>(
        await adminApi.get(`/api/admin/servers/${seedState.server.id}/intents?${query}`),
      );
      connectIntent = intentPage.items.find(
        (intent) => intent.kind === 'server.connect' && intent.status === 'succeeded',
      );
      cursor = intentPage.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(connectIntent, 'seeded server.connect intent').toBeTruthy();
    expect(connectIntent).toMatchObject({
      kind: 'server.connect',
      status: 'succeeded',
      serverId: seedState.server.id,
      requestSummary: {
        trustTokenRef: expect.any(String),
      },
    });
    expect(connectIntent?.requestSummary).not.toHaveProperty('trustToken');

    const current = await expectJson<JsonRecord>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}`),
    );
    const preflight = await expectJson<JsonRecord>(
      await adminApi.post(`/api/admin/servers/${seedState.server.id}/preflight`, {
        data: {
          expectedServerRevision: current.revision,
          poolId: seedState.storagePools.dirQuotaOnline.id,
          probeAddress: requireRuntimeEnv('E2E_INCUS_PROBE_ADDRESS'),
        },
      }),
      202,
    );
    expect(preflight.intentId).toBeTruthy();
    const preflightIntent = await eventually(
      async () => expectJson<JsonRecord>(
        await adminApi.get(`/api/intents/${preflight.intentId}`),
      ),
      (intent) => intent.status === 'succeeded',
      180_000,
      500,
      'server preflight intent',
    );
    expect(preflightIntent.kind).toBe('server.preflight');

    const report = await expectJson<JsonRecord>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}/preflight`),
    );
    expect(report).toMatchObject({
      status: 'passed',
      report: {
        status: 'passed',
        controlReady: true,
        checks: {
          api: 'pass',
          parentInterface: 'pass',
          nftables: 'pass',
          ipv4Filtering: 'pass',
          guestCanReachHost: 'pass',
          networkPrerequisites: 'pass',
          storagePool: 'pass',
          simplestreamsImage: 'pass',
          guestAddress: 'pass',
          egress: 'pass',
          nodeMetrics: 'pass',
        },
      },
    });
    expect(report.report.checkedAt).toBeTruthy();
    const probeName = `nyabase-preflight-${seedState.server.id.replaceAll('-', '')}`;
    await expect.poll(
      async () => incusStatus(`/1.0/instances/${encodeURIComponent(probeName)}`),
      { timeout: 30_000 },
    ).toBe(404);
  },
);

test(
  'rotates the control-plane certificate and observes its intent',
  { ...coverageCase('server-certificate-rotation', 'server-certificate-rotation-live') },
  async ({ adminApi }) => {
    const active = await expectJson<JsonRecord>(
      await adminApi.get('/api/admin/incus-client-certificate'),
    );
    expect(Number(active.generation)).toBeGreaterThanOrEqual(1);

    const rotation = await expectJson<JsonRecord>(
      await adminApi.post('/api/admin/incus-client-certificate/rotate', {
        data: { expectedGeneration: active.generation },
      }),
    );
    expect(rotation.rotationId).toBeTruthy();
    const result = await eventually(
      async () => expectJson<JsonRecord>(
        await adminApi.get(
          `/api/admin/incus-client-certificate/rotations/${rotation.rotationId}`,
        ),
      ),
      (entry) => entry.status === 'succeeded',
      180_000,
      500,
      'certificate rotation intent',
    );
    expect(Number(result.generation)).toBeGreaterThan(Number(active.generation));
  },
);

test(
  'assigns the immutable simplestreams image fingerprint to the server',
  { ...coverageCase('image-assignment-fingerprint', 'image-assignment-live') },
  async ({ adminApi, seedState }) => {
    const catalog = await expectJson<JsonRecord[]>(await adminApi.get('/api/admin/images'));
    expect(catalog.some((entry) => entry.id === seedState.image.id)).toBe(true);
    const userCatalog = await expectJson<JsonRecord[]>(await adminApi.get('/api/images'));
    expect(Array.isArray(userCatalog)).toBe(true);
    const userImage = await adminApi.get(`/api/images/${seedState.image.id}`);
    expect([200, 403, 404]).toContain(userImage.status());
    if (userImage.status() === 200) {
      const body = await userImage.json() as JsonRecord;
      expect(body.id).toBe(seedState.image.id);
    }
    await expectJson(await adminApi.get(`/api/admin/images/${seedState.image.id}/status`));
    await expectJson(
      await adminApi.get(`/api/admin/images/${seedState.image.id}/assignments/status`),
    );
    await expectJson(await adminApi.get(`/api/admin/images/${seedState.image.id}/intents`));
    await expectJson(
      await adminApi.get(
        `/api/admin/images/${seedState.image.id}/assignments/${seedState.server.id}/intents`,
      ),
    );
    const missingAssignment = await adminApi.delete(
      `/api/admin/images/${seedState.image.id}/assignments/00000000-0000-4000-8000-0000000000aa`,
    );
    expect([202, 400, 404, 409]).toContain(missingAssignment.status());

    const image = await expectJson<JsonRecord>(
      await adminApi.get(`/api/admin/images/${seedState.image.id}`),
    );
    const fingerprint = image.fingerprint ?? image.sourceFingerprint ?? image.managedFingerprint;
    expect(fingerprint).toBe(seedState.image.fingerprint);
    expect(image.alias).toBe(seedState.image.alias);

    const assignment = await expectJson<JsonRecord>(
      await adminApi.put(
        `/api/admin/images/${seedState.image.id}/assignments/${seedState.server.id}`,
        { data: {} },
      ),
      202,
    );
    expect(assignment.intent?.intentId ?? assignment.intentId).toBeTruthy();
    const assignmentIntentId = assignment.intent?.intentId ?? assignment.intentId;
    const assignmentResult = await eventually(
      async () => expectJson<JsonRecord>(
        await adminApi.get(`/api/intents/${assignmentIntentId}`),
      ),
      (intent) => intent.status === 'succeeded',
      180_000,
      500,
      'image assignment intent',
    );
    expect(assignmentResult.kind).toBe('image_assignment.ensure');

    const assignments = await eventually(
      async () => expectJson<JsonRecord[]>(
        await adminApi.get(`/api/admin/images/${seedState.image.id}/assignments`),
      ),
      (entries) => entries.some((entry) => (
        entry.serverId === seedState.server.id
        && entry.lifecyclePhase === 'active'
        && entry.managedFingerprint === seedState.image.fingerprint
      )),
      180_000,
      500,
      'image assignment convergence',
    );
    expect(assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: seedState.image.assignmentId,
        serverId: seedState.server.id,
        lifecyclePhase: 'active',
        managedFingerprint: seedState.image.fingerprint,
      }),
    ]));
  },
);
