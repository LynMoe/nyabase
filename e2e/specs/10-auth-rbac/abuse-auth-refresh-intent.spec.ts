import { createHash, randomBytes } from 'node:crypto';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import {
  assertNoActiveIntents,
  createUserContainer,
  deletePersonaUser,
  deleteUserContainer,
  errorMessageText,
  loginPersona,
  provisionGrantedUser,
  readErrorBody,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

function requestId(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex');
}

test(
  'refresh-token replay and non-owner intent retry are rejected without duplicate active intents',
  { ...coverageCase('abuse-auth-refresh-replay-and-intent-retry', 'abuse-auth-refresh-intent-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(300_000);
    const owner = await provisionGrantedUser(adminApi, seedState, 'refo');
    const stranger = await provisionGrantedUser(adminApi, seedState, 'refs');
    let ownerApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let strangerApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let ownerRefresh: string | undefined;
    let strangerRefresh: string | undefined;
    let containerId: string | undefined;
    let createIntentId: string | undefined;
    try {
      const loginApi = await trackedApiFactory();
      const ownerSession = await loginPersona(loginApi, owner);
      ownerRefresh = ownerSession.refreshToken;
      ownerApi = await authedApiFactory(ownerSession.accessToken);

      const firstRequestId = requestId();
      const rotated = await expectJson<JsonRecord>(
        await loginApi.post('/api/auth/refresh', {
          data: {
            refreshToken: ownerSession.refreshToken,
            requestId: firstRequestId,
          },
        }),
      );
      expect(rotated.refreshToken).toBeTruthy();
      expect(rotated.accessToken).toBeTruthy();
      ownerRefresh = rotated.refreshToken as string;

      // Idempotent recovery with the same predecessor+requestId is allowed.
      const recovered = await expectJson<JsonRecord>(
        await loginApi.post('/api/auth/refresh', {
          data: {
            refreshToken: ownerSession.refreshToken,
            requestId: firstRequestId,
          },
        }),
      );
      expect(recovered.refreshToken).toBe(rotated.refreshToken);

      // Replaying the predecessor with a different requestId must fail.
      const replay = await readErrorBody(
        await loginApi.post('/api/auth/refresh', {
          data: {
            refreshToken: ownerSession.refreshToken,
            requestId: requestId(),
          },
        }),
      );
      expect(replay.status).toBe(401);

      const logoutResponse = await loginApi.post('/api/auth/logout', {
        data: { refreshToken: rotated.refreshToken },
      });
      expect([200, 204]).toContain(logoutResponse.status());
      ownerRefresh = undefined;
      const afterLogout = await readErrorBody(
        await loginApi.post('/api/auth/refresh', {
          data: {
            refreshToken: rotated.refreshToken,
            requestId: requestId(),
          },
        }),
      );
      expect(afterLogout.status).toBe(401);

      // Fresh session for resource + intent abuse.
      const fresh = await loginPersona(await trackedApiFactory(), owner);
      ownerRefresh = fresh.refreshToken;
      ownerApi = await authedApiFactory(fresh.accessToken);
      const me = await expectJson<JsonRecord>(await ownerApi.get('/api/auth/me'));
      expect(me.id).toBe(owner.userId);

      const created = await createUserContainer(ownerApi, seedState, {
        namePrefix: 'e2e-ref',
        powerIntent: 'stopped',
      });
      containerId = created.containerId;
      createIntentId = created.intentId;

      const strangerSession = await loginPersona(await trackedApiFactory(), stranger);
      strangerRefresh = strangerSession.refreshToken;
      strangerApi = await authedApiFactory(strangerSession.accessToken);

      const retryDenied = await readErrorBody(
        await strangerApi.post(`/api/intents/${createIntentId}/retry`, { data: {} }),
      );
      expect(retryDenied.status).toBe(403);
      expect(errorMessageText(retryDenied.body)).toMatch(/Intent is not owned by current user/i);

      // Succeeded intents cannot be retried.
      const retrySucceeded = await readErrorBody(
        await ownerApi.post(`/api/intents/${createIntentId}/retry`, { data: {} }),
      );
      expect(retrySucceeded.status).toBe(409);
      expect(errorMessageText(retrySucceeded.body)).toMatch(
        /Only failed intents can be retried/i,
      );

      await assertNoActiveIntents(ownerApi, `/api/containers/${containerId}/intents`);
    } finally {
      if (ownerApi) {
        await deleteUserContainer(ownerApi, adminApi, containerId);
      } else {
        await deleteUserContainer(adminApi, adminApi, containerId);
      }
      for (const token of [ownerRefresh, strangerRefresh]) {
        if (!token) continue;
        await (await trackedApiFactory()).post('/api/auth/logout', {
          data: { refreshToken: token },
        }).catch(() => undefined);
      }
      await deletePersonaUser(adminApi, stranger.userId);
      await deletePersonaUser(adminApi, owner.userId);
    }
  },
);
