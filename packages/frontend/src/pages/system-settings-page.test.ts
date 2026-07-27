import { describe, expect, it } from 'vitest';
import type { SystemSettingFieldDto } from '@nyabase/common';
import { editableInputValue } from './system-settings-page.js';

describe('System Settings PostgreSQL projection', () => {
  it('edits the effective database value instead of stale bootstrap YAML', () => {
    expect(editableInputValue({
      source: 'database',
      effectiveValue: 'Persisted title',
      yamlValue: 'Bootstrap title',
      defaultValue: 'nyabase',
    } as SystemSettingFieldDto)).toBe('Persisted title');
  });

  it('preserves bootstrap YAML input before PostgreSQL authority is loaded', () => {
    expect(editableInputValue({
      source: 'yaml',
      effectiveValue: 'Bootstrap title',
      yamlValue: 'Bootstrap title',
      defaultValue: 'nyabase',
    } as SystemSettingFieldDto)).toBe('Bootstrap title');
  });
});
