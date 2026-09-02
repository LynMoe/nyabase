import { readFileSync, writeFileSync } from 'node:fs';
import type { ApiClient } from './api-client.js';
import { expect } from './expect.js';
import { expectJson } from './http.js';
import { runCommand, runIncus } from './incus-control.js';
import { eventually } from './poll.js';
import { currentRunId, requireRuntimeEnv } from './runtime-env.js';
import type { SeedState } from './seed-state.js';
import { waitForGone } from './wait-for-gone.js';

export type JsonRecord = Record<string, any>;

export type LabServer = NonNullable<SeedState['labServers']>[number];

export type VolumeKind = 'local' | 'shared';

export function adminContainerVolumesPath(
  containerId: string,
  kind: VolumeKind = 'local',
): string {
  return kind === 'shared'
    ? `/api/admin/containers/${containerId}/shared-volumes`
    : `/api/admin/containers/${containerId}/volumes`;
}

export function adminVolumePath(volumeId: string, kind: VolumeKind = 'local'): string {
  return kind === 'shared'
    ? `/api/admin/shared-volumes/${volumeId}`
    : `/api/admin/volumes/${volumeId}`;
}

export async function waitForIntent(
  api: ApiClient,
  intentId: string,
  timeoutMs = 180_000,
): Promise<JsonRecord> {
  return eventually(
    async () => expectJson<JsonRecord>(
      await api.get(`/api/admin/intents/${intentId}`),
    ),
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

export function nonGpuLabServers(seedState: SeedState): LabServer[] {
  return (seedState.labServers ?? []).filter((server) => server.role !== 'gpu');
}

export async function registeredCephPool(
  api: ApiClient,
  serverId: string,
): Promise<JsonRecord> {
  const pools = await expectJson<JsonRecord[]>(
    await api.get(`/api/admin/servers/${serverId}/storage-pools`),
  );
  const cephPool = pools.find(
    (pool) => pool.driver === 'cephfs' && pool.shareable === true && pool.registered === true,
  );
  expect(cephPool?.id, `CephFS pool on ${serverId}`).toBeTruthy();
  if (!cephPool) throw new Error(`CephFS pool missing on ${serverId}`);
  return cephPool;
}

export async function createRunningContainer(
  api: ApiClient,
  seedState: Pick<SeedState, 'adminUserId' | 'server' | 'image'>,
  namePrefix: string,
  serverId = seedState.server.id,
): Promise<string> {
  const accepted = await expectJson<JsonRecord>(
    await api.post('/api/admin/containers', {
      data: {
        ownerId: seedState.adminUserId,
        serverId,
        imageId: seedState.image.id,
        name: `${namePrefix}-${Date.now().toString(36)}`,
        rootSizeBytes: 2 * 1024 * 1024 * 1024,
        cpuMillis: 500,
        memBytes: 512 * 1024 * 1024,
        extensions: {},
        powerIntent: 'running',
      },
    }),
    202,
  );
  const containerId = accepted.resourceId as string;
  await requireSucceededIntent(api, accepted.intentId, 'container.create');
  await eventually(
    async () => expectJson<JsonRecord>(
      await api.get(`/api/admin/containers/${containerId}`),
    ),
    (value) => value.lifecyclePhase === 'active' && value.actual?.status === 'running',
    180_000,
    500,
    `container ${containerId} running`,
  );
  return containerId;
}

export async function createRunningContainerWithVolumes(
  api: ApiClient,
  seedState: Pick<SeedState, 'adminUserId' | 'server' | 'image'>,
  namePrefix: string,
  volumes: Array<{ volumeId: string; containerPath: string; readOnly: boolean }>,
  serverId = seedState.server.id,
): Promise<string> {
  const accepted = await expectJson<JsonRecord>(
    await api.post('/api/admin/containers', {
      data: {
        ownerId: seedState.adminUserId,
        serverId,
        imageId: seedState.image.id,
        name: `${namePrefix}-${Date.now().toString(36)}`,
        rootSizeBytes: 2 * 1024 * 1024 * 1024,
        cpuMillis: 500,
        memBytes: 512 * 1024 * 1024,
        extensions: {},
        powerIntent: 'running',
        volumes,
      },
    }),
    202,
  );
  const containerId = accepted.resourceId as string;
  await requireSucceededIntent(api, accepted.intentId, 'container.create with volumes');
  await eventually(
    async () => expectJson<JsonRecord>(
      await api.get(`/api/admin/containers/${containerId}`),
    ),
    (value) => value.lifecyclePhase === 'active' && value.actual?.status === 'running',
    180_000,
    500,
    `container ${containerId} running with volumes`,
  );
  return containerId;
}

export async function execInContainer(
  api: ApiClient,
  containerId: string,
  command: string,
  ssh?: string,
): Promise<string> {
  const container = await expectJson<JsonRecord>(
    await api.get(`/api/admin/containers/${containerId}`),
  );
  const instanceName = container.instanceName as string;
  expect(instanceName, JSON.stringify(container)).toBeTruthy();
  if (ssh) {
    const remote = [
      'incus',
      'exec',
      instanceName,
      '--',
      '/bin/sh',
      '-lc',
      JSON.stringify(command),
    ].join(' ');
    const result = await runCommand('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
      ssh,
      remote,
    ]);
    expect(result.code, `${result.stderr}\nremote=${remote}`).toBe(0);
    return result.stdout;
  }
  const result = await runIncus(['exec', instanceName, '--', '/bin/sh', '-lc', command]);
  expect(result.code, JSON.stringify(result)).toBe(0);
  return result.stdout;
}

export async function deleteContainer(
  api: ApiClient,
  containerId: string | undefined,
): Promise<void> {
  if (!containerId) return;
  const deletion = await api.post(
    `/api/admin/containers/${containerId}/actions/delete`,
  ).catch(() => undefined);
  if (deletion?.status() === 202) {
    await waitForGone(api, `/api/admin/containers/${containerId}`);
  }
}

export async function stopContainer(
  api: ApiClient,
  containerId: string,
): Promise<void> {
  const current = await expectJson<JsonRecord>(
    await api.get(`/api/admin/containers/${containerId}`),
  );
  if (current.actual?.status === 'stopped' && current.powerIntent === 'stopped') return;
  const accepted = await expectJson<JsonRecord>(
    await api.post(`/api/admin/containers/${containerId}/actions/stop`),
    202,
  );
  await requireSucceededIntent(api, accepted.intentId, 'container.power.stop');
  await eventually(
    async () => expectJson<JsonRecord>(
      await api.get(`/api/admin/containers/${containerId}`),
    ),
    (value) => value.actual?.status === 'stopped' && value.powerIntent === 'stopped',
    180_000,
    500,
    `container ${containerId} stopped`,
  );
}

export async function startContainer(
  api: ApiClient,
  containerId: string,
): Promise<void> {
  const accepted = await expectJson<JsonRecord>(
    await api.post(`/api/admin/containers/${containerId}/actions/start`),
    202,
  );
  await requireSucceededIntent(api, accepted.intentId, 'container.power.start');
  await eventually(
    async () => expectJson<JsonRecord>(
      await api.get(`/api/admin/containers/${containerId}`),
    ),
    (value) => value.lifecyclePhase === 'active' && value.actual?.status === 'running',
    180_000,
    500,
    `container ${containerId} running`,
  );
}

export async function listContainerVolumes(
  api: ApiClient,
  containerId: string,
  kind: VolumeKind = 'local',
): Promise<JsonRecord[]> {
  return expectJson<JsonRecord[]>(
    await api.get(adminContainerVolumesPath(containerId, kind)),
  );
}

export async function createSharedVolume(
  api: ApiClient,
  seedState: Pick<SeedState, 'adminUserId' | 'sharedBackendId'>,
  name: string,
  sizeBytes = 64 * 1024 * 1024,
): Promise<string> {
  expect(seedState.sharedBackendId).toBeTruthy();
  const created = await expectJson<JsonRecord>(
    await api.post('/api/admin/shared-volumes', {
      data: {
        ownerId: seedState.adminUserId,
        name,
        sizeBytes,
        scope: {
          kind: 'shared',
          sharedBackendId: seedState.sharedBackendId,
        },
      },
    }),
    201,
  );
  const volumeId = created.id as string;
  expect(volumeId).toBeTruthy();
  expect(created.lifecyclePhase).toBe('active');
  expect(created.dirEnsured).toBe(false);
  expect(created.poolId).toBeUndefined();
  return volumeId;
}

export async function createLocalVolumeOnServer(
  api: ApiClient,
  seedState: Pick<SeedState, 'adminUserId'>,
  serverId: string,
  poolId: string,
  name: string,
  sizeBytes = 64 * 1024 * 1024,
): Promise<{ volumeId: string; intentId: string }> {
  const accepted = await expectJson<JsonRecord>(
    await api.post('/api/admin/volumes', {
      data: {
        ownerId: seedState.adminUserId,
        name,
        sizeBytes,
        scope: {
          kind: 'local',
          serverId,
          poolId,
        },
      },
    }),
    202,
  );
  return {
    volumeId: accepted.resourceId as string,
    intentId: accepted.intentId as string,
  };
}

async function settleVolumeDeletion(
  api: ApiClient,
  volumeId: string,
  kind: VolumeKind,
  response: { status(): number } | undefined,
): Promise<boolean> {
  if (!response) return false;
  const status = response.status();
  if (status === 200 || status === 204) {
    const gone = await api.get(adminVolumePath(volumeId, kind));
    if (gone.status() !== 404) await waitForGone(api, adminVolumePath(volumeId, kind));
    return true;
  }
  if (status === 202) {
    await waitForGone(api, adminVolumePath(volumeId, kind));
    return true;
  }
  if (status === 404) {
    const exists = await api.get(adminVolumePath(volumeId, kind));
    return exists.status() === 404;
  }
  return false;
}

export async function deleteVolume(
  api: ApiClient,
  volumeId: string | undefined,
): Promise<void> {
  if (!volumeId) return;
  const localExists = (await api.get(adminVolumePath(volumeId, 'local')).catch(() => undefined))
    ?.status() === 200;
  const sharedExists = (await api.get(adminVolumePath(volumeId, 'shared')).catch(() => undefined))
    ?.status() === 200;
  if (!localExists && !sharedExists) return;
  const kind: VolumeKind = localExists ? 'local' : 'shared';
  const deletion = await api.delete(adminVolumePath(volumeId, kind)).catch(() => undefined);
  const settled = await settleVolumeDeletion(api, volumeId, kind, deletion);
  if (settled) return;
  const status = deletion?.status();
  const body = deletion
    ? await deletion.json().catch(() => undefined)
    : undefined;
  throw new Error(
    `failed to delete ${kind} volume ${volumeId}: status=${String(status)} body=${JSON.stringify(body)}`,
  );
}

export async function attachVolume(
  api: ApiClient,
  containerId: string,
  volumeId: string,
  containerPath: string,
  kind: VolumeKind = 'local',
): Promise<{
  attachmentId: string;
  intentId: string;
  bindState?: string;
  onlineCancelAllowed?: boolean;
}> {
  const accepted = await expectJson<JsonRecord>(
    await api.post(adminContainerVolumesPath(containerId, kind), {
      data: {
        volumeId,
        containerPath,
        readOnly: false,
      },
    }),
    202,
  );
  await requireSucceededIntent(api, accepted.intentId, 'volume.attach');
  const attachments = await listContainerVolumes(api, containerId, kind);
  const attachment = attachments.find((entry) => entry.volumeId === volumeId
    && entry.containerPath === containerPath);
  expect(attachment?.id, JSON.stringify(attachments)).toBeTruthy();
  return {
    attachmentId: attachment!.id as string,
    intentId: accepted.intentId as string,
    bindState: attachment!.bindState as string | undefined,
    onlineCancelAllowed: attachment!.onlineCancelAllowed as boolean | undefined,
  };
}

export async function detachVolume(
  api: ApiClient,
  containerId: string,
  attachmentId: string,
  kind: VolumeKind = 'local',
): Promise<void> {
  const response = await api.delete(
    `${adminContainerVolumesPath(containerId, kind)}/${attachmentId}`,
  );
  if (response.status() === 409) {
    const body = await response.json();
    const code = conflictCode(body);
    if (code === 'VOLUME_DETACH_REQUIRES_STOP') {
      throw new Error(
        `VOLUME_DETACH_REQUIRES_STOP: stop the container before detach `
        + `(container=${containerId} attachment=${attachmentId})`,
      );
    }
    throw new Error(`volume.detach 409: ${JSON.stringify(body)}`);
  }
  const accepted = await expectJson<JsonRecord>(response, 202);
  await requireSucceededIntent(api, accepted.intentId, 'volume.detach');
}

export async function expectDetachRequiresStop(
  api: ApiClient,
  containerId: string,
  attachmentId: string,
  kind: VolumeKind = 'local',
): Promise<void> {
  const response = await api.delete(
    `${adminContainerVolumesPath(containerId, kind)}/${attachmentId}`,
  );
  expect(response.status()).toBe(409);
  expect(conflictCode(await response.json())).toBe('VOLUME_DETACH_REQUIRES_STOP');
}

export async function expectStartBusyWhileDetaching(
  api: ApiClient,
  containerId: string,
): Promise<void> {
  const response = await api.post(`/api/admin/containers/${containerId}/actions/start`);
  expect(response.status()).toBe(409);
  expect(conflictCode(await response.json())).toBe('INSTANCE_BUSY');
}

export async function waitForDetachOracle(
  api: ApiClient,
  containerId: string,
  volumeId: string,
  poolName: string,
  incusName: string,
  ssh?: string,
): Promise<{ row: JsonRecord; catalogPresent: boolean; onlineCancel: boolean }> {
  return eventually(
    async () => {
      const listed = await listContainerVolumes(api, containerId, 'shared');
      const row = listed.find((entry) => entry.volumeId === volumeId);
      const catalogPresent = await incusCustomVolumeExists(poolName, incusName, ssh);
      return { row, catalogPresent };
    },
    (snapshot) => {
      const row = snapshot.row;
      if (!row?.id) return false;
      if (row.bindState === 'attached') return row.onlineCancelAllowed === false;
      if (row.bindState === 'attaching' && !snapshot.catalogPresent) {
        return row.onlineCancelAllowed === true;
      }
      if (snapshot.catalogPresent) return row.onlineCancelAllowed === false;
      return false;
    },
    20_000,
    100,
    `detach oracle for ${volumeId}`,
  ).then((snapshot) => {
    const row = snapshot.row!;
    const onlineCancel = row.bindState === 'attaching' && !snapshot.catalogPresent;
    expect(row.onlineCancelAllowed).toBe(onlineCancel);
    if (row.bindState === 'attached') expect(row.onlineCancelAllowed).toBe(false);
    return { row, catalogPresent: snapshot.catalogPresent, onlineCancel };
  });
}

export async function incusCustomVolumeExists(
  poolName: string,
  incusName: string,
  ssh?: string,
): Promise<boolean> {
  if (ssh) {
    const result = await runCommand('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
      ssh,
      ['incus', 'storage', 'volume', 'show', poolName, `custom/${incusName}`].join(' '),
    ]);
    return result.code === 0;
  }
  const result = await runIncus([
    'storage',
    'volume',
    'show',
    poolName,
    `custom/${incusName}`,
  ]);
  return result.code === 0;
}

export async function deleteIncusCustomVolume(
  poolName: string,
  incusName: string,
  ssh?: string,
): Promise<void> {
  if (ssh) {
    await runCommand('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
      ssh,
      ['incus', 'storage', 'volume', 'delete', poolName, `custom/${incusName}`].join(' '),
    ]);
    return;
  }
  await runIncus(['storage', 'volume', 'delete', poolName, `custom/${incusName}`]);
}

export type CephCatalogServer = {
  id: string;
  ssh?: string;
  poolName: string;
};

export async function listCephCatalogServers(
  api: ApiClient,
  seedState: SeedState,
): Promise<CephCatalogServer[]> {
  const candidates: Array<{ id: string; ssh?: string }> = [
    { id: seedState.server.id },
    ...(seedState.labServers ?? []).map((server) => ({ id: server.id, ssh: server.ssh })),
  ];
  const found: CephCatalogServer[] = [];
  for (const server of candidates) {
    const pools = await expectJson<JsonRecord[]>(
      await api.get(`/api/admin/servers/${server.id}/storage-pools`),
    );
    const ceph = pools.find(
      (pool) => pool.driver === 'cephfs' && pool.shareable === true && pool.registered === true,
    );
    if (ceph?.incusName) {
      found.push({ id: server.id, ssh: server.ssh, poolName: String(ceph.incusName) });
    }
  }
  return found;
}

export async function assertNoCephCatalog(
  incusName: string,
  servers: CephCatalogServer[],
): Promise<void> {
  for (const server of servers) {
    expect(
      await incusCustomVolumeExists(server.poolName, incusName, server.ssh),
      `unexpected catalog ${incusName} on ${server.id}`,
    ).toBe(false);
  }
}

export async function waitForCephCatalogGone(
  incusName: string,
  servers: CephCatalogServer[],
  timeoutMs = 120_000,
): Promise<void> {
  for (const server of servers) {
    await eventually(
      async () => incusCustomVolumeExists(server.poolName, incusName, server.ssh),
      (exists) => exists === false,
      timeoutMs,
      2_000,
      `catalog ${incusName} gone on ${server.ssh ?? server.id}`,
    );
  }
}

function labServerSlug(server: LabServer): string {
  const extra = server as LabServer & { slug?: string };
  if (typeof extra.slug === 'string' && extra.slug.length > 0) return extra.slug;
  const file = process.env.E2E_LAB_SERVERS_FILE?.trim();
  if (file) {
    try {
      const defs = JSON.parse(readFileSync(file, 'utf8')) as Array<{
        ssh?: string;
        apiEndpoint?: string;
        slug?: string;
      }>;
      const match = defs.find((entry) => entry.ssh === server.ssh
        || entry.apiEndpoint === server.endpoint);
      if (match?.slug) return match.slug;
    } catch {
      // fall through to the name-derived slug
    }
  }
  return server.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 64);
}

function parseTrustToken(raw: string): string {
  const lines = String(raw ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const token = [...lines].reverse().find((line) => line.length >= 32 && !line.includes(' '));
  expect(token, `incus trust add did not print a token: ${raw.slice(0, 200)}`).toBeTruthy();
  return token!;
}

async function sshOnLab(
  ssh: string,
  remote: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCommand('ssh', [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    ssh,
    remote,
  ]);
}

async function forgetControlPlaneCertOnLab(api: ApiClient, ssh: string): Promise<void> {
  const active = await api.get('/api/admin/incus-client-certificate')
    .then(async (response) => (response.status() === 200 ? await response.json() as JsonRecord : null))
    .catch(() => null);
  const fingerprint = typeof active?.fingerprint === 'string'
    ? active.fingerprint.replace(/[:-\s]/g, '').toLowerCase()
    : '';
  if (fingerprint.length >= 32) {
    await sshOnLab(ssh, `incus config trust remove ${fingerprint} || true`);
  }
}

export async function restoreLabServer(
  api: ApiClient,
  seedState: SeedState,
  server: LabServer,
): Promise<string> {
  const info = await sshOnLab(server.ssh, 'incus query /1.0');
  expect(info.code, info.stderr).toBe(0);
  const parsed = JSON.parse(info.stdout) as JsonRecord;
  const name = String(
    (parsed.metadata as JsonRecord | undefined)?.environment
      ? ((parsed.metadata as JsonRecord).environment as JsonRecord).server_name
      : (parsed.environment as JsonRecord | undefined)?.server_name ?? server.name,
  );
  await forgetControlPlaneCertOnLab(api, server.ssh);
  const tokenName = `e2e-restore-${Date.now().toString(36)}`.slice(0, 40);
  const trustRaw = await sshOnLab(server.ssh, `incus config trust add ${tokenName}`);
  expect(trustRaw.code, trustRaw.stderr).toBe(0);
  const trustToken = parseTrustToken(`${trustRaw.stdout}\n${trustRaw.stderr}`);
  const listed = await expectJson<JsonRecord[]>(await api.get('/api/admin/servers'));
  const existing = listed.find((row) => row.apiEndpoint === server.endpoint || row.slug === labServerSlug(server));
  let serverId = existing?.id as string | undefined;
  if (!serverId) {
    const created = await expectJson<JsonRecord>(
      await api.post('/api/admin/servers', {
        data: {
          name,
          slug: labServerSlug(server),
          apiEndpoint: server.endpoint,
          parentInterface: server.parentInterface,
          dnsServers: [],
        },
      }),
      [200, 201],
    );
    serverId = created.id as string;
  }
  expect(serverId).toBeTruthy();
  const connected = await expectJson<JsonRecord>(
    await api.post(`/api/admin/servers/${serverId}/connect`, {
      data: {
        trustToken,
        expectedServerCertFingerprint: server.certificateFingerprint,
      },
    }),
    202,
  );
  await requireSucceededIntent(api, connected.intentId, `restore connect ${name}`);
  await eventually(
    async () => expectJson<JsonRecord>(await api.get(`/api/admin/servers/${serverId}`)),
    (row) => row.status === 'online',
    90_000,
    1_000,
    `restored lab server ${name} online`,
  );
  await api.post(`/api/admin/servers/${serverId}/storage-pools/discover`);
  const pools = await expectJson<JsonRecord[]>(
    await api.get(`/api/admin/servers/${serverId}/storage-pools`),
  );
  const dirPool = pools.find((pool) => pool.id === server.dirPoolId)
    ?? pools.find((pool) => pool.driver === 'dir' && pool.resizeFamily === 'quota_online');
  const cephPool = pools.find((pool) => pool.driver === 'cephfs' && pool.shareable === true);
  const lvmPool = pools.find((pool) => pool.driver === 'lvm');
  for (const pool of [dirPool, cephPool, lvmPool]) {
    if (!pool || pool.registered) continue;
    await api.patch(`/api/admin/storage-pools/${pool.id}`, {
      data: {
        expectedRevision: pool.revision,
        registered: true,
        ...(pool.driver === 'cephfs' && seedState.sharedBackendId
          ? { sharedBackendId: seedState.sharedBackendId }
          : {}),
      },
    });
  }
  persistLabServerIdentity(seedState, server, {
    id: serverId!,
    dirPoolId: dirPool?.id as string | undefined,
    cephfsPoolId: cephPool?.id as string | undefined,
  });
  await ensureLabServerReady(api, seedState, serverId!, dirPool?.id as string | undefined);
  await eventually(
    async () => expectJson<JsonRecord>(await api.get(`/api/admin/servers/${serverId}`)),
    (row) => row.status === 'online',
    90_000,
    1_000,
    `restored lab server ${name} still online after preflight`,
  );
  return serverId!;
}

export function persistLabServerIdentity(
  seedState: SeedState,
  previous: LabServer,
  next: { id: string; dirPoolId?: string; cephfsPoolId?: string },
): void {
  previous.id = next.id;
  if (next.dirPoolId) previous.dirPoolId = next.dirPoolId;
  if (next.cephfsPoolId) previous.cephfsPoolId = next.cephfsPoolId;
  for (const entry of seedState.labServers ?? []) {
    if (entry.endpoint === previous.endpoint || entry.ssh === previous.ssh) {
      entry.id = previous.id;
      entry.dirPoolId = previous.dirPoolId;
      if (previous.cephfsPoolId) entry.cephfsPoolId = previous.cephfsPoolId;
    }
  }
  if (seedState.gpuServer && (
    seedState.gpuServer.endpoint === previous.endpoint
    || seedState.gpuServer.ssh === previous.ssh
  )) {
    seedState.gpuServer.id = previous.id;
    seedState.gpuServer.dirPoolId = previous.dirPoolId;
  }
  const path = requireRuntimeEnv('E2E_SEED_STATE');
  const disk = JSON.parse(readFileSync(path, 'utf8')) as SeedState;
  for (const entry of disk.labServers ?? []) {
    if (entry.endpoint === previous.endpoint || entry.ssh === previous.ssh || entry.name === previous.name) {
      entry.id = previous.id;
      entry.dirPoolId = previous.dirPoolId;
      if (previous.cephfsPoolId) entry.cephfsPoolId = previous.cephfsPoolId;
    }
  }
  if (disk.gpuServer && (
    disk.gpuServer.endpoint === previous.endpoint || disk.gpuServer.ssh === previous.ssh
  )) {
    disk.gpuServer.id = previous.id;
    disk.gpuServer.dirPoolId = previous.dirPoolId;
  }
  writeFileSync(path, `${JSON.stringify(disk, null, 2)}\n`, { mode: 0o600 });
}

async function fingerprintHttps(host: string, port: string): Promise<string | undefined> {
  const result = await runCommand('bash', [
    '-lc',
    `echo | openssl s_client -connect ${JSON.stringify(`${host}:${port}`)} 2>/dev/null | openssl x509 -noout -fingerprint -sha256`,
  ]);
  const value = String(result.stdout ?? '').split('=').pop()?.trim();
  return value && /^[0-9A-Fa-f:]{32,95}$/.test(value) ? value : undefined;
}

async function ensureWorkerNodeMetrics(
  api: ApiClient,
  serverId: string,
  endpoint: string,
): Promise<void> {
  const token = process.env.E2E_NODE_EXPORTER_TOKEN?.trim();
  if (!token) return;
  let server = await expectJson<JsonRecord>(await api.get(`/api/admin/servers/${serverId}`));
  const host = new URL(endpoint).hostname;
  const metricsUrl = `https://${host}:19181/metrics`;
  const fingerprint = await fingerprintHttps(host, '19181')
    ?? process.env.E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT;
  if (!fingerprint) return;
  if (server.nodeMetrics?.endpoint === metricsUrl) return;
  await api.patch(`/api/admin/servers/${serverId}`, {
    data: {
      expectedRevision: server.revision,
      nodeMetrics: {
        endpoint: metricsUrl,
        serverCertFingerprint: fingerprint,
        token,
      },
    },
  });
}

async function ensureIpPoolBinding(api: ApiClient, serverId: string): Promise<void> {
  const pools = await expectJson<JsonRecord[]>(await api.get('/api/admin/ip-pools'));
  const cidr = requireRuntimeEnv('E2E_INCUS_ROUTED_SUBNET');
  const pool = pools.find((entry) => entry.cidr === cidr);
  expect(pool?.id, `IP pool for ${cidr}`).toBeTruthy();
  const serverIds = [...new Set([...(pool!.serverIds ?? []), serverId])];
  if ((pool!.serverIds ?? []).includes(serverId)) return;
  await expectJson(
    await api.patch(`/api/admin/ip-pools/${pool!.id}`, {
      data: { expectedRevision: pool!.revision, serverIds },
    }),
  );
}

export async function ensureLabServerReady(
  api: ApiClient,
  seedState: SeedState,
  serverId: string,
  dirPoolId?: string,
): Promise<void> {
  await ensureIpPoolBinding(api, serverId);
  let server = await expectJson<JsonRecord>(await api.get(`/api/admin/servers/${serverId}`));
  await ensureWorkerNodeMetrics(api, serverId, server.apiEndpoint ?? '');
  server = await expectJson<JsonRecord>(await api.get(`/api/admin/servers/${serverId}`));
  if (dirPoolId && server.systemPoolId !== dirPoolId) {
    await expectJson(
      await api.patch(`/api/admin/servers/${serverId}`, {
        data: { expectedRevision: server.revision, systemPoolId: dirPoolId },
      }),
    );
    server = await expectJson<JsonRecord>(await api.get(`/api/admin/servers/${serverId}`));
  }
  const preflight = await expectJson<JsonRecord>(
    await api.get(`/api/admin/servers/${serverId}/preflight`),
  );
  if (preflight.status !== 'passed') {
    const poolId = dirPoolId ?? server.systemPoolId;
    expect(poolId, `system pool missing for ${serverId}`).toBeTruthy();
    const accepted = await expectJson<JsonRecord>(
      await api.post(`/api/admin/servers/${serverId}/preflight`, {
        data: {
          expectedServerRevision: server.revision,
          poolId,
          probeAddress: requireRuntimeEnv('E2E_INCUS_PROBE_ADDRESS'),
        },
      }),
      202,
    );
    await requireSucceededIntent(api, accepted.intentId, `preflight ${serverId}`);
  }
  await ensureImageAssignment(api, seedState, serverId);
}

export async function ensureImageAssignment(
  api: ApiClient,
  seedState: SeedState,
  serverId: string,
): Promise<void> {
  const assignments = await expectJson<JsonRecord[]>(
    await api.get(`/api/admin/images/${seedState.image.id}/assignments`),
  );
  const current = assignments.find((entry) => entry.serverId === serverId);
  if (
    current?.lifecyclePhase === 'active'
    && String(current.managedFingerprint ?? '').toLowerCase() === seedState.image.fingerprint.toLowerCase()
  ) {
    return;
  }
  const accepted = await expectJson<JsonRecord>(
    await api.put(`/api/admin/images/${seedState.image.id}/assignments/${serverId}`, {
      data: current ? { expectedGeneration: current.generation } : {},
    }),
    202,
  );
  const intentId = (accepted.intent as JsonRecord | undefined)?.intentId ?? accepted.intentId;
  expect(intentId, JSON.stringify(accepted)).toBeTruthy();
  await requireSucceededIntent(api, intentId, `image assignment ${serverId}`);
}

export async function liveLabServer(
  api: ApiClient,
  seedState: SeedState,
  server: LabServer,
): Promise<LabServer> {
  const existing = await api.get(`/api/admin/servers/${server.id}`);
  if (existing.status() === 200) return server;
  const listed = await expectJson<JsonRecord[]>(await api.get('/api/admin/servers'));
  const match = listed.find((row) => row.apiEndpoint === server.endpoint);
  expect(match?.id, `lab server missing for ${server.endpoint}`).toBeTruthy();
  const pools = await expectJson<JsonRecord[]>(
    await api.get(`/api/admin/servers/${match!.id}/storage-pools`),
  );
  const dirPool = pools.find((pool) => pool.driver === 'dir' && pool.registered === true);
  const cephPool = pools.find(
    (pool) => pool.driver === 'cephfs' && pool.shareable === true && pool.registered === true,
  );
  persistLabServerIdentity(seedState, server, {
    id: match!.id as string,
    dirPoolId: dirPool?.id as string | undefined,
    cephfsPoolId: cephPool?.id as string | undefined,
  });
  return server;
}

export async function pickPreflightReadyWorker(
  api: ApiClient,
  seedState: SeedState,
): Promise<LabServer> {
  const workers = nonGpuLabServers(seedState);
  expect(workers.length).toBeGreaterThanOrEqual(1);
  for (const worker of workers) {
    const live = await liveLabServer(api, seedState, worker);
    const preflight = await api.get(`/api/admin/servers/${live.id}/preflight`);
    if (preflight.status() !== 200) continue;
    const body = await preflight.json() as JsonRecord;
    if (body.status === 'passed') {
      await ensureImageAssignment(api, seedState, live.id);
      return live;
    }
  }
  throw new Error('no preflight-ready non-GPU lab worker is available for cascade');
}

export function conflictCode(body: unknown): string {
  const text = JSON.stringify(body);
  const match = text.match(/VOLUME_[A-Z0-9_]+|INSTANCE_BUSY|STORAGE_POOL_IN_USE/);
  return match?.[0] ?? text.slice(0, 200);
}

export async function listShareableCephPools(
  api: ApiClient,
  seedState: SeedState,
): Promise<JsonRecord[]> {
  const serverIds = [
    seedState.server.id,
    ...(seedState.labServers ?? []).map((server) => server.id),
    seedState.gpuServer?.id,
  ].filter((id): id is string => Boolean(id));
  const pools: JsonRecord[] = [];
  for (const serverId of [...new Set(serverIds)]) {
    const listed = await expectJson<JsonRecord[]>(
      await api.get(`/api/admin/servers/${serverId}/storage-pools`),
    );
    for (const pool of listed) {
      if (
        pool.driver === 'cephfs'
        && pool.shareable === true
        && pool.sharedBackendId === seedState.sharedBackendId
      ) {
        pools.push({ ...pool, serverId });
      }
    }
  }
  return pools;
}

export async function patchPoolRegistered(
  api: ApiClient,
  poolId: string,
  expectedRevision: number,
  registered: boolean,
): Promise<JsonRecord> {
  return expectJson<JsonRecord>(
    await api.patch(`/api/admin/storage-pools/${poolId}`, {
      data: { expectedRevision, registered },
    }),
    200,
  );
}

export async function withCephPoolsUnregistered<T>(
  api: ApiClient,
  pools: JsonRecord[],
  work: () => Promise<T>,
): Promise<T> {
  const snapshot = pools
    .filter((pool) => pool.registered === true)
    .map((pool) => ({
      id: pool.id as string,
      serverId: pool.serverId as string,
      revision: Number(pool.revision),
    }));
  try {
    for (const pool of snapshot) {
      await patchPoolRegistered(api, pool.id, pool.revision, false);
    }
    return await work();
  } finally {
    for (const pool of [...snapshot].reverse()) {
      const listed = await expectJson<JsonRecord[]>(
        await api.get(`/api/admin/servers/${pool.serverId}/storage-pools`),
      );
      const current = listed.find((row) => row.id === pool.id);
      if (!current) throw new Error(`pool ${pool.id} missing while restoring registration`);
      if (current.registered === true) continue;
      await patchPoolRegistered(api, pool.id, Number(current.revision), true);
    }
  }
}

export function incusSizeToBytes(raw: string): number {
  const text = raw.trim().toLowerCase().replace(/\s+/g, '');
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)(kib|mib|gib|tib|kb|mb|gb|b)?$/);
  if (!match) throw new Error(`unreadable Incus size ${JSON.stringify(raw)}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 'b';
  const multiplier = {
    b: 1,
    kb: 1_000,
    kib: 1024,
    mb: 1_000_000,
    mib: 1024 * 1024,
    gb: 1_000_000_000,
    gib: 1024 * 1024 * 1024,
    tib: 1024 * 1024 * 1024 * 1024,
  }[unit];
  if (!multiplier) throw new Error(`unknown Incus size unit ${unit}`);
  return Math.round(amount * multiplier);
}

export function incusSizeMatches(raw: string, expectedBytes: number): boolean {
  const parsed = incusSizeToBytes(raw);
  return Math.abs(parsed - expectedBytes) < 1024 * 1024;
}

export async function waitForIncusVolumeSize(
  poolName: string,
  incusName: string,
  expectedBytes: number,
  ssh?: string,
  timeoutMs = 90_000,
): Promise<string> {
  return eventually(
    async () => incusCustomVolumeSize(poolName, incusName, ssh),
    (size) => incusSizeMatches(size, expectedBytes),
    timeoutMs,
    1_000,
    `catalog ${incusName} on ${ssh ?? 'primary'} size=${expectedBytes}`,
  );
}

export async function waitForSharedResizeIntents(
  api: ApiClient,
  volumeId: string,
): Promise<void> {
  const page = await expectJson<{ items: JsonRecord[] }>(
    await api.get(`/api/admin/shared-volumes/${volumeId}/intents`),
  );
  const pending = page.items.filter(
    (intent) => intent.kind === 'volume.resize' && intent.status === 'pending',
  );
  for (const intent of pending) {
    await requireSucceededIntent(api, intent.id as string, `volume.resize ${intent.serverId ?? ''}`);
  }
}

export async function incusCustomVolumeSize(
  poolName: string,
  incusName: string,
  ssh?: string,
): Promise<string> {
  const args = ['storage', 'volume', 'get', poolName, `custom/${incusName}`, 'size'];
  if (ssh) {
    const result = await runCommand('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
      ssh,
      ['incus', ...args].join(' '),
    ]);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  const result = await runIncus(args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

export async function withBlockedIncusHttps<T>(
  endpoint: string,
  work: () => Promise<T>,
): Promise<T> {
  if (process.env.E2E_ENABLE_NETWORK_MUTATION !== '1') {
    throw new Error('BLOCKED: set E2E_ENABLE_NETWORK_MUTATION=1 to cut Incus HTTPS');
  }
  const url = new URL(endpoint);
  const host = url.hostname;
  const port = url.port || '8443';
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    throw new Error(`refusing to block the primary Incus endpoint ${endpoint}`);
  }
  const comment = `nbe2e${currentRunId().replace(/[^a-z0-9]/gi, '').slice(-16)}`;
  const insert = await runCommand('iptables', [
    '-w',
    '-I',
    'OUTPUT',
    '1',
    '-p',
    'tcp',
    '-d',
    host,
    '--dport',
    port,
    '-m',
    'comment',
    '--comment',
    comment,
    '-j',
    'REJECT',
    '--reject-with',
    'tcp-reset',
  ]);
  expect(insert.code, insert.stderr).toBe(0);
  try {
    return await work();
  } finally {
    await runCommand('iptables', [
      '-w',
      '-D',
      'OUTPUT',
      '-p',
      'tcp',
      '-d',
      host,
      '--dport',
      port,
      '-m',
      'comment',
      '--comment',
      comment,
      '-j',
      'REJECT',
      '--reject-with',
      'tcp-reset',
    ]);
  }
}
