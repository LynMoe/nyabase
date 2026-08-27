import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import {
  assertNoActiveIntents,
  createUserVolume,
  deletePersonaUser,
  deleteUserVolume,
  errorCode,
  errorMessageText,
  loginPersona,
  provisionGrantedUser,
  readErrorBody,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

test(
  'stale expectedRevision and malformed bodies are rejected without mutating volumes',
  { ...coverageCase('abuse-revision-conflict-and-malformed', 'abuse-revision-malformed-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(180_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'rev');
    let refreshToken: string | undefined;
    let volumeId: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const created = await createUserVolume(
        userApi,
        seedState,
        `e2e-rev-${Date.now().toString(36)}`,
        128 * 1024 * 1024,
      );
      volumeId = created.volumeId;
      const before = await expectJson<JsonRecord>(await userApi.get(`/api/volumes/${volumeId}`));
      const generation = Number(before.generation ?? before.revision ?? 0);
      expect(Number.isFinite(generation)).toBe(true);

      const stale = await readErrorBody(
        await userApi.patch(`/api/volumes/${volumeId}`, {
          data: {
            expectedRevision: generation + 100,
            name: `stale-${Date.now().toString(36)}`,
          },
        }),
      );
      expect(stale.status).toBe(409);
      expect(errorCode(stale.body)).toBe('REVISION_CONFLICT');

      const adminStale = await readErrorBody(
        await adminApi.patch(`/api/admin/volumes/${volumeId}`, {
          data: {
            expectedRevision: generation + 100,
            sizeBytes: 256 * 1024 * 1024,
          },
        }),
      );
      expect(adminStale.status).toBe(409);
      expect(errorCode(adminStale.body)).toBe('REVISION_CONFLICT');

      const malformed = await readErrorBody(
        await userApi.patch(`/api/volumes/${volumeId}`, {
          data: {
            expectedRevision: generation,
          },
        }),
      );
      expect(malformed.status).toBe(400);
      expect(
        errorCode(malformed.body) === 'INVALID_INPUT'
          || /expectedRevision|At least one volume field/i.test(errorMessageText(malformed.body)),
      ).toBe(true);

      const omitRevision = await readErrorBody(
        await userApi.patch(`/api/volumes/${volumeId}`, {
          data: {
            name: `norev-${Date.now().toString(36)}`,
          },
        }),
      );
      expect(omitRevision.status).toBe(400);

      const after = await expectJson<JsonRecord>(await userApi.get(`/api/volumes/${volumeId}`));
      expect(Number(after.generation ?? after.revision)).toBe(generation);
      expect(Number(after.sizeBytes)).toBe(Number(before.sizeBytes));
      expect(after.name).toBe(before.name);
      await assertNoActiveIntents(adminApi, `/api/admin/volumes/${volumeId}/intents`);
    } finally {
      await deleteUserVolume(userApi ?? adminApi, adminApi, volumeId);
      if (refreshToken) {
        await (await trackedApiFactory()).post('/api/auth/logout', {
          data: { refreshToken },
        }).catch(() => undefined);
      }
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);
