import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { runIncus } from '../../support/incus-control.js';
import {
  createUserContainer,
  createUserVolume,
  deletePersonaUser,
  deleteUserContainer,
  deleteUserVolume,
  loginPersona,
  provisionGrantedUser,
  requireSucceededIntent,
  stopUserContainer,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

const MiB = 1024 * 1024;

test(
  'a read-only volume attach rejects writes inside the guest',
  { ...coverageCase('user-volume-readonly-attach', 'user-volume-readonly-attach-live') },
  async ({ adminApi, authedApiFactory, seedState }) => {
    test.setTimeout(360_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'voro');
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let containerId: string | undefined;
    let volumeId: string | undefined;
    let attachmentId: string | undefined;
    try {
      const session = await loginPersona(adminApi, persona);
      userApi = await authedApiFactory(session.accessToken);
      const created = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-voro',
        powerIntent: 'running',
      });
      containerId = created.containerId;
      const volume = await createUserVolume(
        userApi,
        seedState,
        `e2e-voro-${Date.now().toString(36)}`,
        64 * MiB,
      );
      volumeId = volume.volumeId;

      const attach = await expectJson<JsonRecord>(
        await userApi.post(`/api/containers/${containerId}/volumes`, {
          data: {
            volumeId,
            containerPath: '/mnt/e2e-ro',
            readOnly: true,
          },
        }),
        202,
      );
      await requireSucceededIntent(userApi, attach.intentId, 'user.volume.attach.readonly');
      const attachments = await expectJson<JsonRecord[]>(
        await userApi.get(`/api/containers/${containerId}/volumes`),
      );
      const attachment = attachments.find((entry) => entry.volumeId === volumeId);
      expect(attachment?.id).toBeTruthy();
      expect(attachment?.readOnly === true || attachment?.readonly === true).toBe(true);
      attachmentId = attachment!.id as string;

      const container = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/containers/${containerId}`),
      );
      const instanceName = container.instanceName as string;
      expect(instanceName).toBeTruthy();
      const readable = await runIncus([
        'exec',
        instanceName,
        '--',
        '/bin/sh',
        '-lc',
        'test -d /mnt/e2e-ro && echo mounted',
      ]);
      expect(readable.code, readable.stderr).toBe(0);
      expect(readable.stdout).toContain('mounted');
      const write = await runIncus([
        'exec',
        instanceName,
        '--',
        '/bin/sh',
        '-lc',
        'printf denied > /mnt/e2e-ro/probe; echo write_rc=$?',
      ]);
      expect(write.stdout).toMatch(/write_rc=[1-9]/);

      await stopUserContainer(userApi, containerId);
      const detach = await expectJson<JsonRecord>(
        await userApi.delete(`/api/containers/${containerId}/volumes/${attachmentId}`),
        202,
      );
      await requireSucceededIntent(userApi, detach.intentId, 'user.volume.detach.readonly');
      attachmentId = undefined;
    } finally {
      if (attachmentId && containerId && userApi) {
        await userApi.delete(`/api/containers/${containerId}/volumes/${attachmentId}`)
          .catch(() => undefined);
      }
      await deleteUserVolume(userApi ?? adminApi, adminApi, volumeId);
      await deleteUserContainer(userApi ?? adminApi, adminApi, containerId);
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);
