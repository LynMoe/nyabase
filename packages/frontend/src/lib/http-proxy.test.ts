import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  composeHttpProxyHostname,
  formatRequestCount,
  httpProxyDomainRootLabel,
  isHttpProxyPrefixLabel,
  splitHttpProxyHostname,
  userVisibleBindingState,
} from './http-proxy.js';
import { readSource } from './read-source.test-helper.js';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

describe('http proxy binding display', () => {
  it('formats request counts with grouping, then 万 / 亿', () => {
    expect(formatRequestCount(0)).toBe('0');
    expect(formatRequestCount(9_999)).toBe('9,999');
    expect(formatRequestCount(12_345)).toBe('1.2万');
    expect(formatRequestCount(10_000)).toBe('1万');
    expect(formatRequestCount(3_456_789)).toBe('346万');
    expect(formatRequestCount(99_999_999)).toBe('1亿');
    expect(formatRequestCount(250_000_000)).toBe('2.5亿');
  });

  it('never shows owners the entry-HTTPS warning', () => {
    expect(userVisibleBindingState({ status: 'warning', warningReasons: ['https_not_configured'] }))
      .toEqual({ status: 'ready', warning: '' });
    expect(userVisibleBindingState({
      status: 'warning',
      warningReasons: ['https_not_configured', 'container_not_running'],
    })).toEqual({ status: 'warning', warning: '容器未运行' });
    expect(userVisibleBindingState({ status: 'disabled', warningReasons: ['domain_pool_disabled'] }))
      .toEqual({ status: 'disabled', warning: '域名池已停用' });
  });

  it('the user page has no HTTPS column and both binding tables share the traffic cells', () => {
    const user = readSource(srcRoot, 'pages/http-proxy-page.tsx');
    expect(user).not.toMatch(/HTTPS|entryHttpsEnabled|warningMessage/);
    expect(user).toMatch(/<BindingTrafficHeads \/>/);
    expect(user).toMatch(/<BindingTrafficCells stats=\{binding\.stats\} \/>/);
    const admin = readSource(srcRoot, 'pages/http-proxy-ops-page.tsx');
    expect(admin).toMatch(/<BindingTrafficHeads \/>/);
    expect(admin).toMatch(/<BindingTrafficCells stats=\{binding\.stats\} \/>/);
  });
});
