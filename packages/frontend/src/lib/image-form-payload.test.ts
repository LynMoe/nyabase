import { describe, expect, it } from 'vitest';
import {
  minimalImageEditPayload,
  normalizeImageRuntimeOverridesForUi,
  parseImageFormPayload,
  type ImageFormPayloadInput,
} from './image-form-payload.js';

const base: ImageFormPayloadInput = {
  name: 'image',
  dockerImage: 'ubuntu:24.04',
  uid: '0',
  entrypoint: '',
  cmd: '',
  init: false,
  disableSsh: false,
  description: 'old',
};

describe('image form payload', () => {
  it('completes partial persisted runtime DTOs and rejects malformed fields without throwing', () => {
    expect(normalizeImageRuntimeOverridesForUi({ uid: 1000 })).toEqual({
      uid: 1000, entrypoint: null, cmd: null, init: false,
    });
    expect(normalizeImageRuntimeOverridesForUi({
      uid: -1, entrypoint: 'bad', cmd: [1], init: 'true',
    })).toEqual({ uid: 0, entrypoint: null, cmd: null, init: false });
    expect(normalizeImageRuntimeOverridesForUi(null)).toEqual({
      uid: 0, entrypoint: null, cmd: null, init: false,
    });
  });

  it('rejects exponent and partial decimal UID strings', () => {
    expect(parseImageFormPayload('create', { ...base, uid: '1e2' }).success).toBe(false);
    expect(parseImageFormPayload('create', { ...base, uid: '12x' }).success).toBe(false);
  });

  it('enforces the canonical UID maximum and submits the parsed value', () => {
    const accepted = parseImageFormPayload('create', { ...base, uid: String(0xffff_fffe) });
    expect(accepted.success && accepted.data.runtimeOverrides.uid).toBe(0xffff_fffe);
    expect(parseImageFormPayload('create', { ...base, uid: String(0xffff_ffff) }).success).toBe(false);
  });

  it('uses explicit null to clear an edited description', () => {
    const parsed = parseImageFormPayload('edit', { ...base, description: '   ' });
    expect(parsed.success && parsed.data.description).toBeNull();
  });

  it('builds an edit patch only from dirty form fields', () => {
    const parsed = parseImageFormPayload('edit', { ...base, name: 'new', uid: '42' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(minimalImageEditPayload(parsed.data, new Set(['name']))).toEqual({ name: 'new' });
    expect(minimalImageEditPayload(parsed.data, new Set(['uid']))).toEqual({
      runtimeOverrides: parsed.data.runtimeOverrides,
    });
  });
});
