import { describe, expect, it, vi } from 'vitest';
import type { AuthoritativeSystemSettingsSnapshot } from '../platform/config/nyabase-config.service.js';
import {
  fillMissingOnlineEditableDefaults,
  SystemSettingsAuthorityService,
} from './system-settings-authority.service.js';

describe('fillMissingOnlineEditableDefaults', () => {
  it('adds missing online-editable keys and leaves present values alone', () => {
    const values: Record<string, unknown> = { 'branding.title': 'Keep' };
    const filled = fillMissingOnlineEditableDefaults(values);
    expect(filled).toContain('incus.imageSourceServer');
    expect(values['incus.imageSourceServer'])
      .toBe('https://nyabase-images.nyabase-lxc-images.workers.dev');
    expect(values['branding.title']).toBe('Keep');
    expect(fillMissingOnlineEditableDefaults(values)).toEqual([]);
  });
});

describe('SystemSettingsAuthorityService.committed', () => {
  it('applies a committed snapshot and refreshes the SSH proxy only for a newer revision', async () => {
    const applyAuthoritativeSnapshot = vi.fn().mockReturnValue(true);
    const broadcastSnapshot = vi.fn().mockResolvedValue(undefined);
    let revision = 1;
    const authority = new SystemSettingsAuthorityService(
      {} as never,
      {
        revision: () => revision,
        applyAuthoritativeSnapshot: (snapshot: AuthoritativeSystemSettingsSnapshot) => {
          revision = snapshot.revision;
          return applyAuthoritativeSnapshot(snapshot);
        },
      } as never,
      {} as never,
      { broadcastSnapshot } as never,
    );

    await authority.committed({ revision: 2, values: {} });
    expect(applyAuthoritativeSnapshot).toHaveBeenCalledTimes(1);
    expect(broadcastSnapshot).toHaveBeenCalledTimes(1);

    await authority.committed({ revision: 2, values: {} });
    expect(broadcastSnapshot).toHaveBeenCalledTimes(1);
  });
});
