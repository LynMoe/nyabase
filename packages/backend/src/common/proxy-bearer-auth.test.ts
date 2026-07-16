import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'http';
import {
  configuredProxyTokenDigest,
  hasValidBearerToken,
} from './proxy-bearer-auth.js';

const TOKEN = 'p'.repeat(64);

describe('proxy bearer authentication', () => {
  it('requires an explicit bounded strong token at Backend startup', () => {
    expect(() => configuredProxyTokenDigest('', 'proxy.token')).toThrow(/explicit/);
    expect(() => configuredProxyTokenDigest('short', 'proxy.token')).toThrow(/explicit/);
    expect(() => configuredProxyTokenDigest(` ${TOKEN}`, 'proxy.token')).toThrow(/ASCII/);
    expect(() => configuredProxyTokenDigest(`${'a'.repeat(32)} internal`, 'proxy.token')).toThrow(/ASCII/);
    expect(() => configuredProxyTokenDigest(`${'a'.repeat(31)}\n${'b'.repeat(31)}`, 'proxy.token')).toThrow(/ASCII/);
    expect(() => configuredProxyTokenDigest(`é${'a'.repeat(32)}`, 'proxy.token')).toThrow(/ASCII/);
    expect(() => configuredProxyTokenDigest('x'.repeat(1025), 'proxy.token')).toThrow(/1024/);
    expect(configuredProxyTokenDigest(TOKEN, 'proxy.token')).toHaveLength(32);
  });

  it('accepts only an exact Authorization Bearer header and ignores query credentials', () => {
    const expected = configuredProxyTokenDigest(TOKEN, 'proxy.token');
    const request = (authorization?: string, url = '/ws/proxy') => ({
      headers: authorization === undefined ? {} : { authorization },
      url,
    }) as IncomingMessage;

    expect(hasValidBearerToken(request(`Bearer ${TOKEN}`), expected)).toBe(true);
    expect(hasValidBearerToken(request(`Bearer ${TOKEN}x`), expected)).toBe(false);
    expect(hasValidBearerToken(request(`Bearer  ${TOKEN}`), expected)).toBe(false);
    expect(hasValidBearerToken(request(`bearer ${TOKEN}`), expected)).toBe(false);
    expect(hasValidBearerToken(request(undefined, `/ws/proxy?token=${TOKEN}`), expected)).toBe(false);
  });
});
