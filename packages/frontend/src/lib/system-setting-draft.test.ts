import { describe, expect, it } from 'vitest';
import { controlPlaneConfigManifest, type SystemSettingFieldDto } from '@nyabase/common';
import { parseSystemSettingDraft } from './system-setting-draft.js';

function field(key: string): SystemSettingFieldDto {
  const manifest = controlPlaneConfigManifest.find((item) => item.key === key)!;
  return {
    ...manifest,
    effectiveValue: manifest.defaultValue,
    source: 'default',
    yamlValue: undefined,
    envValuePresent: false,
  };
}

describe('system setting draft parsing', () => {
  it('does not coerce a blank numeric input to zero', () => {
    expect(parseSystemSettingDraft(field('audit.retentionDays'), '')).toEqual({
      success: false,
      error: '数值不能为空',
    });
  });

  it('uses the canonical numeric boundaries', () => {
    expect(parseSystemSettingDraft(field('ssh.proxySnapshotStaleMs'), '119999').success).toBe(false);
    expect(parseSystemSettingDraft(field('ssh.proxySnapshotStaleMs'), '120000')).toMatchObject({ success: true, value: 120000 });
    expect(parseSystemSettingDraft(field('ssh.proxySnapshotStaleMs'), '300001').success).toBe(false);
  });
});
