import { describe, expect, it } from 'vitest';
import {
  composeHttpProxyHostname,
  httpProxyDomainRootLabel,
  isHttpProxyPrefixLabel,
  splitHttpProxyHostname,
} from './http-proxy.js';

const pools = [
  { id: 'dp-1', wildcardDomain: '*.lab.test' },
  { id: 'dp-2', wildcardDomain: '*.example.com' },
];

describe('http proxy hostname prefix', () => {
  it('labels the domain root without the wildcard star', () => {
    expect(httpProxyDomainRootLabel('*.lab.test')).toBe('lab.test');
  });

  it('accepts a single DNS label as prefix', () => {
    expect(isHttpProxyPrefixLabel('app')).toBe(true);
    expect(isHttpProxyPrefixLabel('app-1')).toBe(true);
    expect(isHttpProxyPrefixLabel('app.extra')).toBe(false);
    expect(isHttpProxyPrefixLabel('*.app')).toBe(false);
    expect(isHttpProxyPrefixLabel('')).toBe(false);
  });

  it('composes and splits a hostname against enabled pools', () => {
    expect(composeHttpProxyHostname('app', '*.lab.test')).toBe('app.lab.test');
    expect(splitHttpProxyHostname('app.lab.test', pools)).toEqual({ prefix: 'app', poolId: 'dp-1' });
    expect(splitHttpProxyHostname('www.example.com', pools)).toEqual({ prefix: 'www', poolId: 'dp-2' });
    expect(splitHttpProxyHostname('too.deep.lab.test', pools)).toBeNull();
  });
});
