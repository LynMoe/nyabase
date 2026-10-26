import { describe, expect, it } from 'vitest';
import {
  controlPlaneConfigDefinitions,
  controlPlaneConfigManifest,
} from '../config/definition.js';

describe('control-plane config definition', () => {
  it('has unique keys, env names, and YAML paths', () => {
    const keys = controlPlaneConfigDefinitions.map((field) => field.key);
    const envs = controlPlaneConfigDefinitions.map((field) => field.env);
    const yamlPaths = controlPlaneConfigDefinitions.map((field) => field.yamlPath);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(envs).size).toBe(envs.length);
    expect(new Set(yamlPaths).size).toBe(yamlPaths.length);
  });

  it('exports a serializable manifest without schemas', () => {
    expect(() => JSON.stringify(controlPlaneConfigManifest)).not.toThrow();
    expect(controlPlaneConfigManifest.length).toBe(controlPlaneConfigDefinitions.length);
    expect(controlPlaneConfigManifest.find((field) => field.key === 'branding.title')).toMatchObject({
      env: 'NYABASE_BRAND_TITLE',
      yamlPath: 'branding.title',
      editable: true,
      public: true,
    });
  });

  it('lets only admins change browser-session lifetimes online', () => {
    // Restart-required and secret settings are never edited online at all.
    const auth = controlPlaneConfigManifest.filter((field) => field.key.startsWith('auth.')
      && field.editable && !field.restartRequired && !field.secret);
    expect(auth.map((field) => field.key).sort()).toEqual([
      'auth.refreshTokenExpiresDays',
      'auth.sessionMaxLifetimeDays',
    ]);
    expect(controlPlaneConfigManifest.find((field) => field.key === 'auth.sessionMaxLifetimeDays'))
      .toMatchObject({ defaultValue: 30, valueKind: 'number', restartRequired: false });
  });
});
