import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson, expectSuccess } from '../../support/http.js';
import {
  createPersonaUser,
  createUserSharedVolume,
  deletePersonaUser,
  deleteServerGrant,
  deleteSharedBackendGrant,
  deleteStoragePoolGrant,
  deleteUserContainer,
  deleteUserSharedVolume,
  loginPersona,
  provisionGrantedUser,
  upsertSharedBackendGrant,
} from '../../support/persona.js';
import { requireSucceededIntent } from '../../support/volume-ops.js';

type JsonRecord = Record<string, any>;

test(
  'grants access with an expiry and revokes it through canonical mutations',
  { ...coverageCase('grant-revoke-expiry', 'grant-lifecycle-live') },
  async ({ adminApi, seedState }) => {
    const persona = await createPersonaUser(adminApi, 'grant');
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const base = `/api/admin/users/${persona.userId}`;
    try {
      const serverGrant = await expectJson<JsonRecord>(
        await adminApi.put(`${base}/server-grants/${seedState.server.id}`, {
          data: {
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            diskBytes: 2 * 1024 * 1024 * 1024,
            extensionGrants: {},
            expiresAt,
          },
        }),
      );
      expect(serverGrant.serverId ?? serverGrant.id).toBeTruthy();
      const serverGrants = await expectJson<JsonRecord[]>(
        await adminApi.get(`${base}/server-grants`),
      );
      expect(serverGrants.some((grant) => grant.serverId === seedState.server.id
        && grant.expiresAt === expiresAt)).toBe(true);

      const poolGrant = await expectJson<JsonRecord>(
        await adminApi.put(`${base}/storage-pool-grants/${seedState.storagePools.dirQuotaOnline.id}`, {
          data: { expiresAt },
        }),
      );
      expect(poolGrant.poolId ?? poolGrant.id).toBeTruthy();
      const poolGrants = await expectJson<JsonRecord[]>(
        await adminApi.get(`${base}/storage-pool-grants`),
      );
      expect(poolGrants.some((grant) => (
        grant.poolId === seedState.storagePools.dirQuotaOnline.id
      ))).toBe(true);

      const effective = await expectJson<JsonRecord>(
        await adminApi.get(`${base}/effective-access`),
      );
      expect(effective.servers).toBeDefined();

      await expectJson(await adminApi.get(`${base}/shared-backend-grants`));
      const missingBackend = '00000000-0000-4000-8000-000000000099';
      const putShared = await adminApi.put(
        `${base}/shared-backend-grants/${missingBackend}`,
        { data: { limitBytes: 1024, expiresAt: null } },
      );
      expect(putShared.status()).toBeGreaterThanOrEqual(400);
      const dropShared = await adminApi.delete(
        `${base}/shared-backend-grants/${missingBackend}`,
      );
      expect([200, 204, 404]).toContain(dropShared.status());

      await expectSuccess(await adminApi.delete(`${base}/storage-pool-grants/${seedState.storagePools.dirQuotaOnline.id}`));
      await expectSuccess(await adminApi.delete(`${base}/server-grants/${seedState.server.id}`));

      const after = await expectJson<JsonRecord[]>(
        await adminApi.get(`${base}/server-grants`),
      );
      expect(after.some((grant) => grant.serverId === seedState.server.id)).toBe(false);
    } finally {
      await deleteStoragePoolGrant(
        adminApi,
        persona.userId,
        seedState.storagePools.dirQuotaOnline.id,
      );
      await deleteServerGrant(adminApi, persona.userId, seedState.server.id);
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);

test(
  'shared volume create requires a backend grant, not disk_bytes; owner can delete after expiry',
  { ...coverageCase('shared-volume-grant-split', 'shared-volume-grant-split-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    expect(seedState.sharedBackendId).toBeTruthy();
    const backendId = seedState.sharedBackendId!;
    const backendOnly = await createPersonaUser(adminApi, 'sbe');
    const diskOnly = await provisionGrantedUser(adminApi, seedState, 'sdisk');
    let backendVolumeId: string | undefined;
    let expiredVolumeId: string | undefined;
    let containerId: string | undefined;
    let backendApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let diskApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    try {
      await upsertSharedBackendGrant(adminApi, backendOnly.userId, backendId, {
        limitBytes: 256 * 1024 * 1024,
      });
      const backendSession = await loginPersona(await trackedApiFactory(), backendOnly);
      backendApi = await authedApiFactory(backendSession.accessToken);
      backendVolumeId = await createUserSharedVolume(
        backendApi,
        seedState,
        `e2e-sbe-${Date.now().toString(36)}`,
      );

      const localDenied = await backendApi.post('/api/volumes', {
        data: {
          name: `e2e-sbe-local-${Date.now().toString(36)}`,
          sizeBytes: 64 * 1024 * 1024,
          scope: {
            kind: 'local',
            serverId: seedState.server.id,
            poolId: seedState.storagePools.dirQuotaOnline.id,
          },
        },
      });
      expect(localDenied.status()).toBe(403);

      const diskSession = await loginPersona(await trackedApiFactory(), diskOnly);
      diskApi = await authedApiFactory(diskSession.accessToken);
      const denied = await diskApi.post('/api/shared-volumes', {
        data: {
          name: `e2e-sdisk-${Date.now().toString(36)}`,
          sizeBytes: 64 * 1024 * 1024,
          scope: { kind: 'shared', sharedBackendId: backendId },
        },
      });
      expect(denied.status()).toBe(403);

      expiredVolumeId = await createUserSharedVolume(
        backendApi,
        seedState,
        `e2e-sexp-${Date.now().toString(36)}`,
      );
      const createdContainer = await expectJson<JsonRecord>(
        await adminApi.post('/api/admin/containers', {
          data: {
            ownerId: backendOnly.userId,
            serverId: seedState.server.id,
            imageId: seedState.image.id,
            name: `e2e-sbe-c-${Date.now().toString(36)}`,
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            extensions: {},
            powerIntent: 'stopped',
          },
        }),
        202,
      );
      containerId = createdContainer.resourceId as string;
      await requireSucceededIntent(adminApi, createdContainer.intentId, 'grant-split container');

      await upsertSharedBackendGrant(adminApi, backendOnly.userId, backendId, {
        limitBytes: 256 * 1024 * 1024,
        expiresAt: new Date(Date.now() - 5_000).toISOString(),
      });
      expect((await backendApi.get(`/api/shared-volumes/${expiredVolumeId}`)).status()).toBe(200);
      const expiredVolume = await expectJson<JsonRecord>(
        await backendApi.get(`/api/shared-volumes/${expiredVolumeId}`),
      );
      const patched = await backendApi.patch(`/api/shared-volumes/${expiredVolumeId}`, {
        data: {
          expectedRevision: expiredVolume.generation,
          sizeBytes: 96 * 1024 * 1024,
        },
      });
      expect(patched.status()).toBe(403);
      const attachDenied = await backendApi.post(
        `/api/containers/${containerId}/shared-volumes`,
        {
          data: {
            volumeId: expiredVolumeId,
            containerPath: '/mnt/shared',
            readOnly: false,
          },
        },
      );
      expect(attachDenied.status()).toBe(403);
      const createAfterExpiry = await backendApi.post('/api/shared-volumes', {
        data: {
          name: `e2e-sexp2-${Date.now().toString(36)}`,
          sizeBytes: 64 * 1024 * 1024,
          scope: { kind: 'shared', sharedBackendId: backendId },
        },
      });
      expect(createAfterExpiry.status()).toBe(403);
      const deleted = await backendApi.delete(`/api/shared-volumes/${expiredVolumeId}`);
      expect([200, 202, 204]).toContain(deleted.status());
      expect((await backendApi.get(`/api/shared-volumes/${expiredVolumeId}`)).status()).toBe(404);
      expiredVolumeId = undefined;
    } finally {
      await deleteUserContainer(backendApi ?? adminApi, adminApi, containerId);
      await deleteUserSharedVolume(backendApi ?? adminApi, adminApi, backendVolumeId);
      await deleteUserSharedVolume(backendApi ?? adminApi, adminApi, expiredVolumeId);
      await deleteSharedBackendGrant(adminApi, backendOnly.userId, backendId);
      await deletePersonaUser(adminApi, backendOnly.userId);
      await deleteStoragePoolGrant(
        adminApi,
        diskOnly.userId,
        seedState.storagePools.dirQuotaOnline.id,
      );
      await deleteServerGrant(adminApi, diskOnly.userId, seedState.server.id);
      await deletePersonaUser(adminApi, diskOnly.userId);
    }
  },
);
