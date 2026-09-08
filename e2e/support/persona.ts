import type { ApiClient } from './api-client.js';
import { expect } from './expect.js';
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
  extensionGrants?: Record<string, unknown>;
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
  adminApi: ApiClient,
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
  adminApi: ApiClient,
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
        extensionGrants: grant.extensionGrants ?? {},
        expiresAt: grant.expiresAt === undefined ? null : grant.expiresAt,
      },
    }),
  );
}

export async function upsertStoragePoolGrant(
  adminApi: ApiClient,
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
  adminApi: ApiClient,
  userId: string,
  serverId: string,
): Promise<void> {
  const response = await adminApi.delete(`/api/admin/users/${userId}/server-grants/${serverId}`);
  // 409 GRANT_REVOCATION_BLOCKED when the user still owns resources — caller should
  // delete resources first; allow 409 here so finally blocks stay best-effort.
  expect([200, 204, 404, 409]).toContain(response.status());
}

export async function deleteStoragePoolGrant(
  adminApi: ApiClient,
  userId: string,
  poolId: string,
): Promise<void> {
  const response = await adminApi.delete(`/api/admin/users/${userId}/storage-pool-grants/${poolId}`);
  expect([200, 204, 404, 409]).toContain(response.status());
}

export async function upsertSharedBackendGrant(
  adminApi: ApiClient,
  userId: string,
  backendId: string,
  grant: { limitBytes: number; expiresAt?: string | null } = { limitBytes: 1024 * 1024 * 1024 },
): Promise<JsonRecord> {
  return expectJson<JsonRecord>(
    await adminApi.put(`/api/admin/users/${userId}/shared-backend-grants/${backendId}`, {
      data: {
        limitBytes: grant.limitBytes,
        expiresAt: grant.expiresAt === undefined ? null : grant.expiresAt,
      },
    }),
  );
}

export async function deleteSharedBackendGrant(
  adminApi: ApiClient,
  userId: string,
  backendId: string,
): Promise<void> {
  const response = await adminApi.delete(
    `/api/admin/users/${userId}/shared-backend-grants/${backendId}`,
  );
  expect([200, 204, 404, 409]).toContain(response.status());
}

export async function loginPersona(
  api: ApiClient,
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
  api: ApiClient,
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
  api: ApiClient,
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
  api: ApiClient,
  seedState: Pick<SeedState, 'server' | 'image'>,
  options: {
    namePrefix?: string;
    cpuMillis?: number;
    memBytes?: number;
    rootSizeBytes?: number;
    powerIntent?: 'running' | 'stopped';
    serverId?: string;
    extensions?: Record<string, unknown>;
    volumes?: Array<{ volumeId: string; containerPath: string; readOnly: boolean }>;
  } = {},
): Promise<{ containerId: string; intentId: string }> {
  const accepted = await expectJson<JsonRecord>(
    await api.post('/api/containers', {
      data: {
        serverId: options.serverId ?? seedState.server.id,
        imageId: seedState.image.id,
        name: `${options.namePrefix ?? 'e2e-u'}-${Date.now().toString(36)}`.slice(0, 63),
        rootSizeBytes: options.rootSizeBytes ?? 2 * 1024 * 1024 * 1024,
        cpuMillis: options.cpuMillis ?? 500,
        memBytes: options.memBytes ?? 512 * 1024 * 1024,
        extensions: options.extensions ?? {},
        powerIntent: options.powerIntent ?? 'running',
        ...(options.volumes ? { volumes: options.volumes } : {}),
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

export async function stopUserContainer(
  api: ApiClient,
  containerId: string,
): Promise<void> {
  const current = await expectJson<JsonRecord>(
    await api.get(`/api/containers/${containerId}`),
  );
  if (current.actual?.status === 'stopped' && current.powerIntent === 'stopped') return;
  const accepted = await expectJson<JsonRecord>(
    await api.post(`/api/containers/${containerId}/actions/stop`),
    202,
  );
  await requireSucceededIntent(api, accepted.intentId, 'container.power.stop');
  await eventually(
    async () => expectJson<JsonRecord>(await api.get(`/api/containers/${containerId}`)),
    (value) => value.actual?.status === 'stopped' && value.powerIntent === 'stopped',
    180_000,
    500,
    `user container ${containerId} stopped`,
  );
}

export async function createUserSharedVolume(
  api: ApiClient,
  seedState: Pick<SeedState, 'sharedBackendId'>,
  name: string,
  sizeBytes = 64 * 1024 * 1024,
  options: { sharedBackendId?: string } = {},
): Promise<string> {
  const sharedBackendId = options.sharedBackendId ?? seedState.sharedBackendId;
  expect(sharedBackendId).toBeTruthy();
  const created = await expectJson<JsonRecord>(
    await api.post('/api/shared-volumes', {
      data: {
        name,
        sizeBytes,
        scope: {
          kind: 'shared',
          sharedBackendId,
        },
      },
    }),
    201,
  );
  const volumeId = created.id as string;
  expect(volumeId).toBeTruthy();
  expect(created.dirEnsured).toBe(false);
  return volumeId;
}

export async function deleteUserSharedVolume(
  api: ApiClient,
  adminApi: ApiClient,
  volumeId: string | undefined,
): Promise<void> {
  if (!volumeId) return;
  const userPath = `/api/shared-volumes/${volumeId}`;
  const adminPath = `/api/admin/shared-volumes/${volumeId}`;
  const userExists = await resourceExists(api, userPath);
  const adminExists = await resourceExists(adminApi, adminPath);
  if (!userExists && !adminExists) return;

  if (userExists) {
    const userDelete = await api.delete(userPath).catch(() => undefined);
    const status = userDelete?.status();
    if (status === 202) {
      await waitForGone(api, userPath).catch(async () => {
        await waitForGone(adminApi, adminPath);
      });
    } else if (status === 200 || status === 204) {
      // PG-only delete
    }
    if (!(await resourceExists(adminApi, adminPath))
      && !(await resourceExists(api, userPath))) {
      return;
    }
  }

  const stillAdmin = await resourceExists(adminApi, adminPath);
  if (!stillAdmin && !(await resourceExists(api, userPath))) return;
  const adminDelete = await adminApi.delete(adminPath).catch(() => undefined);
  const adminStatus = adminDelete?.status();
  if (adminStatus === 202) {
    await waitForGone(adminApi, adminPath);
    return;
  }
  if (adminStatus === 200 || adminStatus === 204 || adminStatus === 404) {
    if (!(await resourceExists(adminApi, adminPath))) return;
  }
  throw new Error(`failed to delete shared volume ${volumeId}`);
}

export async function createUserVolume(
  api: ApiClient,
  seedState: Pick<SeedState, 'server' | 'storagePools'>,
  name: string,
  sizeBytes: number,
  options: { serverId?: string; poolId?: string } = {},
): Promise<{ volumeId: string; intentId: string }> {
  const accepted = await expectJson<JsonRecord>(
    await api.post('/api/volumes', {
      data: {
        name,
        sizeBytes,
        scope: {
          kind: 'local',
          serverId: options.serverId ?? seedState.server.id,
          poolId: options.poolId ?? seedState.storagePools.dirQuotaOnline.id,
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

async function resourceExists(api: ApiClient, path: string): Promise<boolean> {
  const response = await api.get(path).catch(() => undefined);
  return response !== undefined && response.status() !== 404;
}

async function settleDelete(
  response: { status(): number; json(): Promise<unknown> } | undefined,
  wait: () => Promise<void>,
): Promise<boolean> {
  if (!response) return false;
  if (response.status() === 404) return true;
  if (response.status() !== 202) return false;
  await wait();
  return true;
}

export async function deleteUserContainer(
  api: ApiClient,
  adminApi: ApiClient,
  containerId: string | undefined,
): Promise<void> {
  if (!containerId) return;
  const userPath = `/api/containers/${containerId}`;
  const adminPath = `/api/admin/containers/${containerId}`;
  if (
    !(await resourceExists(api, userPath))
    && !(await resourceExists(adminApi, adminPath))
  ) {
    return;
  }

  const stop = await adminApi.post(`${adminPath}/actions/stop`).catch(() => undefined);
  if (stop?.status() === 202) {
    const body = await stop.json() as JsonRecord;
    if (typeof body.intentId === 'string') {
      await requireSucceededIntent(adminApi, body.intentId, 'cleanup.stop').catch(() => undefined);
    }
  }
  for (const kindPath of [`${adminPath}/volumes`, `${adminPath}/shared-volumes`]) {
    const listed = await adminApi.get(kindPath)
      .then(async (response) => (response.status() === 200
        ? await response.json() as JsonRecord[]
        : []))
      .catch(() => [] as JsonRecord[]);
    for (const attachment of listed) {
      if (typeof attachment.id !== 'string') continue;
      const detach = await adminApi.delete(`${kindPath}/${attachment.id}`)
        .catch(() => undefined);
      if (detach?.status() === 202) {
        const body = await detach.json() as JsonRecord;
        if (typeof body.intentId === 'string') {
          await requireSucceededIntent(adminApi, body.intentId, 'cleanup.detach');
        }
      }
    }
  }

  const gone = await settleDelete(
    await api.post(`${userPath}/actions/delete`).catch(() => undefined),
    async () => {
      await waitForGone(api, userPath).catch(async () => {
        await waitForGone(adminApi, adminPath);
      });
    },
  ) || await settleDelete(
    await adminApi.post(`${adminPath}/actions/delete`).catch(() => undefined),
    async () => waitForGone(adminApi, adminPath),
  );
  if (
    gone
    || (!(await resourceExists(api, userPath)) && !(await resourceExists(adminApi, adminPath)))
  ) {
    return;
  }
  throw new Error(`failed to delete container ${containerId}`);
}

export async function deleteUserVolume(
  api: ApiClient,
  adminApi: ApiClient,
  volumeId: string | undefined,
): Promise<void> {
  if (!volumeId) return;
  const userPath = `/api/volumes/${volumeId}`;
  const adminPath = `/api/admin/volumes/${volumeId}`;
  if (
    !(await resourceExists(api, userPath))
    && !(await resourceExists(adminApi, adminPath))
  ) {
    return;
  }
  const gone = await settleDelete(
    await api.delete(userPath).catch(() => undefined),
    async () => {
      await waitForGone(api, userPath).catch(async () => {
        await waitForGone(adminApi, adminPath);
      });
    },
  ) || await settleDelete(
    await adminApi.delete(adminPath).catch(() => undefined),
    async () => waitForGone(adminApi, adminPath),
  );
  if (
    gone
    || (!(await resourceExists(api, userPath)) && !(await resourceExists(adminApi, adminPath)))
  ) {
    return;
  }
  throw new Error(`failed to delete volume ${volumeId}`);
}

export async function deletePersonaUser(
  adminApi: ApiClient,
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
  api: ApiClient,
  resourcePath: string,
  timeoutMs = 60_000,
): Promise<void> {
  await eventually(
    async () => {
      const intents = await expectJson<JsonRecord[] | { items?: JsonRecord[] }>(
        await api.get(resourcePath),
      );
      const items = Array.isArray(intents) ? intents : (intents.items ?? []);
      return items.filter((intent) => (
        intent.status === 'pending' || intent.status === 'running'
      ));
    },
    (active) => active.length === 0,
    timeoutMs,
    500,
    `no active intents on ${resourcePath}`,
  );
}

export async function waitForUserContainerPower(
  api: ApiClient,
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
  api: ApiClient,
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
  adminApi: ApiClient,
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
