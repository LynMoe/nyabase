import { describe, expect, it } from 'vitest';
import { sanitizeInternalRedirect } from './internal-redirect.js';

describe('sanitizeInternalRedirect', () => {
  it('preserves a valid deep link with search and hash', () => {
    expect(sanitizeInternalRedirect('/groups/g-1?tab=grants#image')).toBe('/groups/g-1?tab=grants#image');
  });

  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example/steal',
    '/%2f%2fevil.example/steal',
    'javascript:alert(1)',
    '/ok\nLocation:https://evil.example',
  ])('rejects an external or ambiguous redirect: %s', (candidate) => {
    expect(sanitizeInternalRedirect(candidate)).toBe('/');
  });
});
