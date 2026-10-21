import { describe, expect, it } from 'vitest';
import { isSystemSettingsDto } from './conflict-snapshots.js';

const field = {
  key: 'branding.title',
  yamlPath: 'branding.title',
  env: 'NYABASE_BRAND_TITLE',
  valueKind: 'string',
  source: 'default',
  envValuePresent: false,
  secret: false,
  editable: true,
  restartRequired: false,
  public: true,
  label: 'Brand title',
  description: 'Product title',
};

describe('conflict snapshot validators', () => {
  it('accepts the revision-only system settings snapshot a 409 carries', () => {
    const dto = {
      revision: 3,
      configFile: '/etc/nyabase/config.yaml',
      fields: [field],
      editable: [field],
      readOnly: [],
      publicSettings: { branding: { title: 'nyabase', description: '' }, sshProxy: null },
    };
    expect(isSystemSettingsDto(dto)).toBe(true);
    expect(isSystemSettingsDto({ ...dto, revision: 0 })).toBe(false);
    expect(isSystemSettingsDto({ ...dto, editable: [{ ...field, label: undefined }] })).toBe(false);
  });
});
