import { describe, expect, it, vi } from 'vitest';
import { securityHeaders, trustProxySetting, warnOnUntrustedForwarding } from './http-security.js';

describe('trustProxySetting', () => {
  it('trusts no proxy when unset', () => {
    expect(trustProxySetting('')).toBe(false);
    expect(trustProxySetting(' , ')).toBe(false);
  });

  it('passes trimmed entries to Express', () => {
    expect(trustProxySetting('loopback, 10.0.0.0/8 ,fd00::/8')).toEqual([
      'loopback',
      '10.0.0.0/8',
      'fd00::/8',
    ]);
  });
});

describe('securityHeaders', () => {
  function headersFor() {
    const headers = new Map<string, string>();
    const response = {
      setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), String(value)),
      removeHeader: (name: string) => headers.delete(name.toLowerCase()),
    };
    securityHeaders()({} as never, response as never, () => undefined);
    return headers;
  }

  it('locks scripts and framing to the bundled origin', () => {
    const csp = headersFor().get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  });

  it('leaves HSTS to the TLS edge', () => {
    const headers = headersFor();
    expect(headers.has('strict-transport-security')).toBe(false);
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('warnOnUntrustedForwarding', () => {
  it('warns once when forwarded requests arrive without trusted proxies', () => {
    const warn = vi.fn();
    const next = vi.fn();
    const middleware = warnOnUntrustedForwarding(false, warn);
    middleware({ headers: {} }, {}, next);
    middleware({ headers: { 'x-forwarded-for': '198.51.100.7' } }, {}, next);
    middleware({ headers: { 'x-forwarded-for': '198.51.100.8' } }, {}, next);
    expect(warn).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('stays quiet when a proxy is trusted', () => {
    const warn = vi.fn();
    warnOnUntrustedForwarding(['loopback'], warn)({ headers: { 'x-forwarded-for': '198.51.100.7' } }, {}, () => {});
    expect(warn).not.toHaveBeenCalled();
  });
});
