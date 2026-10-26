import { describe, expect, it, vi } from 'vitest';
import { Role } from '@nyabase/common';
import { SystemSettingsController } from './system-settings.controller.js';
import { SystemSettingsRevisionConflictError } from './system-settings-authority.service.js';

function makeController() {
  let revision = 1;
  const config = {
    allFields: vi.fn(() => [{
      key: 'branding.title',
      yamlPath: 'branding.title',
      env: 'NYABASE_BRAND_TITLE',
      valueKind: 'string',
      effectiveValue: 'nyabase',
      source: 'default',
      yamlValue: undefined,
      envValuePresent: false,
      defaultValue: 'nyabase',
      secret: false,
      editable: true,
      restartRequired: false,
      public: true,
      label: 'Brand title',
      description: 'Product title',
    }]),
    configFile: vi.fn(() => '/etc/nyabase/config.yaml'),
    revision: vi.fn(() => revision),
    publicSettings: vi.fn(() => ({
      branding: { title: 'nyabase', description: 'dev' },
      sshProxy: null,
    })),
  };
  const committedSnapshot = {
    revision: 2,
    values: { 'branding.title': 'Lab Console' },
  };
  const authority = {
    refreshFromPostgres: vi.fn().mockResolvedValue(committedSnapshot),
    update: vi.fn().mockResolvedValue(committedSnapshot),
    committed: vi.fn(async () => {
      revision = 2;
    }),
    acceptConflict: vi.fn((current: typeof committedSnapshot) => {
      revision = current.revision;
    }),
  };
  const accessResolver = {
    runWithActorRole: vi.fn(async (
      _actorId: string,
      _minimum: unknown,
      work: (transaction: unknown) => Promise<unknown>,
    ) => work({ transaction: true })),
  };
  const controller = new SystemSettingsController(
    config as never,
    accessResolver as never,
    authority as never,
  );
  return { controller, config, authority, accessResolver };
}

describe('SystemSettingsController', () => {
  it('patches through the caller PostgreSQL authority transaction', async () => {
    const { controller, authority, accessResolver } = makeController();
    const result = await controller.patchSettings({ id: 'actor-a' } as never, {
      expectedRevision: 1,
      values: { 'branding.title': 'Lab Console' },
    });
    expect(accessResolver.runWithActorRole).toHaveBeenCalledWith(
      'actor-a',
      Role.Admin,
      expect.any(Function),
    );
    expect(authority.update).toHaveBeenCalledWith(
      { transaction: true },
      'actor-a',
      { 'branding.title': 'Lab Console' },
      1,
    );
    expect(authority.committed).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      revision: 2,
      configFile: '/etc/nyabase/config.yaml',
    });
  });

  it('does not mutate or publish after role revocation', async () => {
    const { controller, authority, accessResolver } = makeController();
    accessResolver.runWithActorRole.mockRejectedValueOnce(
      new Error('authority revoked'),
    );
    await expect(controller.patchSettings({ id: 'actor-a' } as never, {
      expectedRevision: 1,
      values: { 'branding.title': 'Unauthorized' },
    })).rejects.toThrow('authority revoked');
    expect(authority.update).not.toHaveBeenCalled();
    expect(authority.committed).not.toHaveBeenCalled();
  });

  it('returns the current purpose-safe snapshot on CAS conflict', async () => {
    const { controller, authority } = makeController();
    const current = {
      revision: 3,
      values: { 'branding.title': 'Current' },
    };
    authority.update.mockRejectedValueOnce(
      new SystemSettingsRevisionConflictError(current),
    );
    let response: unknown;
    try {
      await controller.patchSettings({ id: 'actor-a' } as never, {
        expectedRevision: 1,
        values: { 'branding.title': 'Stale' },
      });
    } catch (error) {
      response = (error as { getResponse(): unknown }).getResponse();
    }
    expect(authority.acceptConflict).toHaveBeenCalledWith(current);
    expect(authority.committed).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      code: 'SYSTEM_SETTINGS_REVISION_CONFLICT',
      current: { revision: 3 },
    });
    expect(response).not.toHaveProperty('current.values');
  });

  it('serves the admin settings snapshot from the live in-process config', () => {
    const { controller, authority } = makeController();
    expect(controller.getSettings()).toMatchObject({ revision: 1 });
    expect(authority.refreshFromPostgres).not.toHaveBeenCalled();
    expect(controller.getSettings()).not.toHaveProperty('snapshotToken');
  });
});
