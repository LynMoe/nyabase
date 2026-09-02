import { describe, expect, it } from 'vitest';
import { FailureCode, PackageHttpError, SERVER_CARD_EXTENSION_ID_RE } from '@nyabase/common';

describe('PackageHttpError', () => {
  it('stores status, code, message, and details', () => {
    const error = new PackageHttpError(409, 'EXTENSION_OCCUPIED', 'occupied', { n: 1 });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PackageHttpError);
    expect(error.name).toBe('PackageHttpError');
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('EXTENSION_OCCUPIED');
    expect(error.message).toBe('occupied');
    expect(error.details).toEqual({ n: 1 });
  });

  it('defaults details to an empty object', () => {
    const error = new PackageHttpError(404, FailureCode.ExtensionUnknown, 'unknown');
    expect(error.details).toEqual({});
  });
});

describe('SERVER_CARD_EXTENSION_ID_RE', () => {
  it('accepts 1–63 character ids matching the SQL CHECK', () => {
    expect(SERVER_CARD_EXTENSION_ID_RE.test('a')).toBe(true);
    expect(SERVER_CARD_EXTENSION_ID_RE.test('example')).toBe(true);
    expect(SERVER_CARD_EXTENSION_ID_RE.test(`a${'b'.repeat(62)}`)).toBe(true);
    expect(SERVER_CARD_EXTENSION_ID_RE.test('1bad')).toBe(false);
    expect(SERVER_CARD_EXTENSION_ID_RE.test('Bad')).toBe(false);
    expect(SERVER_CARD_EXTENSION_ID_RE.test(`a${'b'.repeat(63)}`)).toBe(false);
  });
});
