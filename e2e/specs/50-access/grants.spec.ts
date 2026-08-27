import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson, expectSuccess } from '../../support/http.js';

type JsonRecord = Record<string, any>;

test(
  'grants access with an expiry and revokes it through canonical mutations',
  { ...coverageCase('grant-revoke-expiry', 'grant-lifecycle-live') },
  async ({ adminApi, seedState }) => {
    const userId = seedState.adminUserId;
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const base = `/api/admin/users/${userId}`;

    const serverGrant = await expectJson<JsonRecord>(
      await adminApi.put(`${base}/server-grants/${seedState.server.id}`, {
        data: {
          cpuMillis: 500,
          memBytes: 512 * 1024 * 1024,
          diskBytes: 2 * 1024 * 1024 * 1024,
          gpu: { mode: 'none', pciAddresses: [] },
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

    await expectSuccess(await adminApi.delete(`${base}/storage-pool-grants/${seedState.storagePools.dirQuotaOnline.id}`));
    await expectSuccess(await adminApi.delete(`${base}/server-grants/${seedState.server.id}`));

    const after = await expectJson<JsonRecord[]>(
      await adminApi.get(`${base}/server-grants`),
    );
    expect(after.some((grant) => grant.serverId === seedState.server.id)).toBe(false);
  },
);
