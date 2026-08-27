import { describe, expect, it, vi } from 'vitest';
import type { AuthoritativeSystemSettingsSnapshot } from '../config/nyabase-config.service.js';
import {
  fillMissingOnlineEditableDefaults,
  SystemSettingsAuthorityService,
} from './system-settings-authority.service.js';

describe('fillMissingOnlineEditableDefaults', () => {
  it('adds missing online-editable keys and leaves present values alone', () => {
    const values: Record<string, unknown> = { 'branding.title': 'Keep' };
    const filled = fillMissingOnlineEditableDefaults(values);
    expect(filled).toContain('incus.imageSourceServer');
    expect(values['incus.imageSourceServer']).toBe('');
    expect(values['branding.title']).toBe('Keep');
    expect(fillMissingOnlineEditableDefaults(values)).toEqual([]);
  });
});

describe('SystemSettingsAuthorityService lifecycle', () => {
  it('drains an in-flight refresh without applying or broadcasting after shutdown starts', async () => {
    let resolveLoad!: (snapshot: AuthoritativeSystemSettingsSnapshot) => void;
    const load = new Promise<AuthoritativeSystemSettingsSnapshot>((resolve) => {
      resolveLoad = resolve;
    });
    const applyAuthoritativeSnapshot = vi.fn().mockReturnValue(true);
    const broadcastSnapshot = vi.fn().mockResolvedValue(undefined);
    const authority = new SystemSettingsAuthorityService(
      {} as never,
      {
        revision: vi.fn().mockReturnValue(1),
        applyAuthoritativeSnapshot,
      } as never,
      {} as never,
      { broadcastSnapshot } as never,
    );
    (authority as unknown as {
      load: () => Promise<AuthoritativeSystemSettingsSnapshot>;
    }).load = vi.fn(() => load);

    const refresh = authority.refreshFromPostgres('deferred-test');
    let shutdownFinished = false;
    const shutdown = authority.onApplicationShutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    await expect(authority.refreshFromPostgres('after-stop-during-drain'))
      .rejects.toThrow('System settings authority is stopped');

    resolveLoad({
      revision: 2,
      snapshotToken: 'a'.repeat(64),
      values: {},
    });
    await expect(refresh).resolves.toMatchObject({ revision: 2 });
    await shutdown;

    expect(applyAuthoritativeSnapshot).not.toHaveBeenCalled();
    expect(broadcastSnapshot).not.toHaveBeenCalled();
    await expect(authority.refreshFromPostgres('after-stop'))
      .rejects.toThrow('System settings authority is stopped');
  });
});
