import { expect, type APIRequestContext } from '@playwright/test';
import { expectJson } from './http.js';
import { eventually } from './poll.js';
import { waitForGone } from './wait-for-gone.js';
import type { SeedState } from './seed-state.js';

type JsonRecord = Record<string, any>;

export interface PersonaCredentials {
  userId: string;
  username: string;
  password: string;
  displayName: string;
}

export interface ServerGrantInput {
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  expiresAt?: string | null;
}

const DEFAULT_GRANT: ServerGrantInput = {
  cpuMillis: 1_000,
  memBytes: 1_024 * 1_024 * 1_024,
  diskBytes: 8 * 1_024 * 1_024 * 1_024,
  expiresAt: null,
};

export function uniquePersonaUsername(label: string): string {
  const safe = label.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 12) || 'user';
  return `e2e_${safe}_${Date.now().toString(36)}`.slice(0, 64);
}

export async function createPersonaUser(
  adminApi: APIRequestContext,
  label: string,
): Promise<PersonaCredentials> {
  const username = uniquePersonaUsername(label);
  const password = `E2ePass_${Date.now().toString(36)}_9`;
  const displayName = `E2E ${label}`;
  const created = await expectJson<JsonRecord>(
    await adminApi.post('/api/admin/users', {
      data: { username, password, displayName },
    }),
    [200, 201],
  );
  expect(created.id).toBeTruthy();
  return {
    userId: created.id as string,
    username,
    password,
    displayName,
  };
}

export async function upsertServerGrant(
  adminApi: APIRequestContext,
  userId: string,
  serverId: string,
  grant: ServerGrantInput = DEFAULT_GRANT,
): Promise<JsonRecord> {
  return expectJson<JsonRecord>(
    await adminApi.put(`/api/admin/users/${userId}/server-grants/${serverId}`, {
      data: {
        cpuMillis: grant.cpuMillis,
        memBytes: grant.memBytes,
        diskBytes: grant.diskBytes,
        gpu: { mode: 'none', pciAddresses: [] },
        expiresAt: grant.expiresAt === undefined ? null : grant.expiresAt,
      },
    }),
  );
}

export async function upsertStoragePoolGrant(
  adminApi: APIRequestContext,
  userId: string,
  poolId: string,
  expiresAt: string | null = null,
): Promise<JsonRecord> {
  return expectJson<JsonRecord>(
    await adminApi.put(`/api/admin/users/${userId}/storage-pool-grants/${poolId}`, {
      data: { expiresAt },
    }),
  );
}

export async function deleteServerGrant(
  adminApi: APIRequestContext,
  userId: string,
  serverId: string,
): Promise<void> {
  const response = await adminApi.delete(`/api/admin/users/${userId}/server-grants/${serverId}`);
  // 409 GRANT_REVOCATION_BLOCKED when the user still owns resources — caller should
  // delete resources first; allow 409 here so finally blocks stay best-effort.
  expect([200, 204, 404, 409]).toContain(response.status());
}

export async function deleteStoragePoolGrant(
  adminApi: APIRequestContext,
  userId: string,
  poolId: string,
): Promise<void> {
  const response = await adminApi.delete(`/api/admin/users/${userId}/storage-pool-grants/${poolId}`);
  expect([200, 204, 404, 409]).toContain(response.status());
}

export async function loginPersona(
  api: APIRequestContext,
  credentials: Pick<PersonaCredentials, 'username' | 'password'>,
): Promise<{ accessToken: string; refreshToken: string; user: JsonRecord }> {
  const session = await expectJson<JsonRecord>(
    await api.post('/api/auth/login', {
      data: {
        username: credentials.username,
        password: credentials.password,
      },
    }),
  );
  expect(session.accessToken).toBeTruthy();
  expect(session.refreshToken).toBeTruthy();
  return {
    accessToken: session.accessToken as string,
    refreshToken: session.refreshToken as string,
    user: session.user as JsonRecord,
  };
}

export async function waitForIntent(
  api: APIRequestContext,
  intentId: string,
  timeoutMs = 180_000,
): Promise<JsonRecord> {
  return eventually(
    async () => expectJson<JsonRecord>(await api.get(`/api/intents/${intentId}`)),
    (intent) => intent.status === 'succeeded' || intent.status === 'failed',
    timeoutMs,
    500,
    `intent ${intentId} settled`,
  );
}

export async function requireSucceededIntent(
  api: APIRequestContext,
  intentId: string,
  label: string,
): Promise<JsonRecord> {
  const intent = await waitForIntent(api, intentId);
  expect(intent.status, JSON.stringify({
    label,
    intentId,
    failureCode: intent.failureCode,
    failure: intent.failure,
  })).toBe('succeeded');
  return intent;
}

export async function createUserContainer(
  api: APIRequestContext,
  seedState: Pick<SeedState, 'runId' | 'server' | 'image'>,
  options: {
    namePrefix?: string;
    cpuMillis?: number;
    memBytes?: number;
    rootSizeBytes?: number;
    powerIntent?: 'running' | 'stopped';
  } = {},
): Promise<{ containerId: string; intentId: string }> {
  const accepted = await expectJson<JsonRecord>(
    await api.post('/api/containers', {
      data: {
        serverId: seedState.server.id,
        imageId: seedState.image.id,
        name: `${options.namePrefix ?? 'e2e-u'}-${Date.now().toString(36)}`.slice(0, 63),
        rootSizeBytes: options.rootSizeBytes ?? 2 * 1024 * 1024 * 1024,
        cpuMillis: options.cpuMillis ?? 500,
        memBytes: options.memBytes ?? 512 * 1024 * 1024,
        gpuPciAddresses: [],
        powerIntent: options.powerIntent ?? 'running',
      },
    }),
    202,
  );
  const containerId = accepted.resourceId as string;
  const intentId = accepted.intentId as string;
  await requireSucceededIntent(api, intentId, 'container.create');
  await eventually(
    async () => expectJson<JsonRecord>(await api.get(`/api/containers/${containerId}`)),
    (value) => value.lifecyclePhase === 'active'
      && (options.powerIntent === 'stopped'
        ? value.actual?.status === 'stopped' || value.powerIntent === 'stopped'
        : value.actual?.status === 'running'),
    180_000,
    500,
    `user container ${containerId} ready`,
  );
  return { containerId, intentId };
}

export async function createUserVolume(
  api: APIRequestContext,
  seedState: Pick<SeedState, 'server' | 'storagePools'>,
  name: string,
  sizeBytes: number,
): Promise<{ volumeId: string; intentId: string }> {
  const accepted = await expectJson<JsonRecord>(
    await api.post('/api/volumes', {
      data: {
        name,
        sizeBytes,
        scope: {
          kind: 'local',
          serverId: seedState.server.id,
          poolId: seedState.storagePools.dirQuotaOnline.id,
        },
      },
    }),
    202,
  );
  const volumeId = accepted.resourceId as string;
  const intentId = accepted.intentId as string;
  await requireSucceededIntent(api, intentId, 'volume.ensure');
  return { volumeId, intentId };
}

export async function deleteUserContainer(
  api: APIRequestContext,
  adminApi: APIRequestContext,
  containerId: string | undefined,
): Promise<void> {
  if (!containerId) return;
  const userDelete = await api.post(`/api/containers/${containerId}/actions/delete`)
    .catch(() => undefined);
  if (userDelete?.status() === 202) {
    await waitForGone(api, `/api/containers/${containerId}`).catch(async () => {
      await waitForGone(adminApi, `/api/admin/containers/${containerId}`);
    });
    return;
  }
  const adminDelete = await adminApi.post(`/api/admin/containers/${containerId}/actions/delete`)
    .catch(() => undefined);
  if (adminDelete?.status() === 202) {
    await waitForGone(adminApi, `/api/admin/containers/${containerId}`);
  }
}

export async function deleteUserVolume(
  api: APIRequestContext,
  adminApi: APIRequestContext,
  volumeId: string | undefined,
): Promise<void> {
  if (!volumeId) return;
  const userDelete = await api.delete(`/api/volumes/${volumeId}`).catch(() => undefined);
  if (userDelete?.status() === 202) {
    await waitForGone(api, `/api/volumes/${volumeId}`).catch(async () => {
      await waitForGone(adminApi, `/api/admin/volumes/${volumeId}`);
    });
    return;
  }
  const adminDelete = await adminApi.delete(`/api/admin/volumes/${volumeId}`).catch(() => undefined);
  if (adminDelete?.status() === 202) {
    await waitForGone(adminApi, `/api/admin/volumes/${volumeId}`);
  }
}

export async function deletePersonaUser(
  adminApi: APIRequestContext,
  userId: string | undefined,
): Promise<void> {
  if (!userId) return;
  const response = await adminApi.delete(`/api/admin/users/${userId}`);
  expect(
    [200, 204, 404, 409].includes(response.status()),
    `delete user ${userId} returned ${response.status()}`,
  ).toBe(true);
}

export async function assertNoActiveIntents(
  api: APIRequestContext,
  resourcePath: string,
): Promise<void> {
  const intents = await expectJson<JsonRecord[] | { items?: JsonRecord[] }>(
    await api.get(resourcePath),
  );
  const items = Array.isArray(intents) ? intents : (intents.items ?? []);
  const active = items.filter((intent) => (
    intent.status === 'pending' || intent.status === 'running'
  ));
  expect(active, JSON.stringify(active)).toEqual([]);
}

export async function waitForUserContainerPower(
  api: APIRequestContext,
  containerId: string,
  power: 'running' | 'stopped',
  timeoutMs = 180_000,
): Promise<JsonRecord> {
  return eventually(
    async () => expectJson<JsonRecord>(await api.get(`/api/containers/${containerId}`)),
    (value) => value.lifecyclePhase === 'active'
      && value.powerIntent === power
      && value.actual?.status === power,
    timeoutMs,
    500,
    `user container ${containerId} ${power}`,
  );
}

export async function settleAcceptedIntent(
  api: APIRequestContext,
  response: { status: () => number; json: () => Promise<any> },
  label: string,
): Promise<JsonRecord | null> {
  if (response.status() !== 202) return null;
  const body = await response.json() as JsonRecord;
  if (!body.intentId) return null;
  return waitForIntent(api, body.intentId as string, 300_000).then((intent) => {
    expect(['succeeded', 'failed'], JSON.stringify({ label, intent })).toContain(intent.status);
    return intent;
  });
}

export async function readErrorBody(response: {
  status: () => number;
  text: () => Promise<string>;
  url: () => string;
}): Promise<{ status: number; body: JsonRecord; raw: string }> {
  const raw = await response.text();
  let body: JsonRecord = {};
  try {
    body = raw ? JSON.parse(raw) as JsonRecord : {};
  } catch {
    body = { message: raw };
  }
  return { status: response.status(), body, raw };
}

export function errorMessageText(body: JsonRecord): string {
  const message = body.message;
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    return JSON.stringify(message);
  }
  return JSON.stringify(body);
}

export function errorCode(body: JsonRecord): string | undefined {
  if (typeof body.code === 'string') return body.code;
  if (body.message && typeof body.message === 'object' && typeof body.message.code === 'string') {
    return body.message.code;
  }
  return undefined;
}

export async function provisionGrantedUser(
  adminApi: APIRequestContext,
  seedState: SeedState,
  label: string,
  grant: ServerGrantInput = DEFAULT_GRANT,
): Promise<PersonaCredentials> {
  const persona = await createPersonaUser(adminApi, label);
  await upsertServerGrant(adminApi, persona.userId, seedState.server.id, grant);
  await upsertStoragePoolGrant(
    adminApi,
    persona.userId,
    seedState.storagePools.dirQuotaOnline.id,
    grant.expiresAt === undefined ? null : grant.expiresAt,
  );
  return persona;
}
