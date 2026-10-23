import { describe, expect, it } from 'vitest';
import { hostnameCoversWildcardDomain, wildcardDomainsOverlap } from './http-domain-overlap.js';

describe('wildcardDomainsOverlap', () => {
  it('rejects equal and nested pools in either order', () => {
    expect(wildcardDomainsOverlap('*.example.com', '*.example.com')).toBe(true);
    expect(wildcardDomainsOverlap('*.example.com', '*.a.example.com')).toBe(true);
    expect(wildcardDomainsOverlap('*.b.a.example.com', '*.example.com')).toBe(true);
  });

  it('allows siblings and look-alikes that are not on a label boundary', () => {
    expect(wildcardDomainsOverlap('*.a.example.com', '*.b.example.com')).toBe(false);
    expect(wildcardDomainsOverlap('*.example.com', '*.myexample.com')).toBe(false);
    expect(wildcardDomainsOverlap('*.example.com', '*.example.org')).toBe(false);
  });
});

describe('hostnameCoversWildcardDomain', () => {
  it('flags a hostname that is the base of another pool or one of its ancestors', () => {
    expect(hostnameCoversWildcardDomain('a.example.com', '*.a.example.com')).toBe(true);
    expect(hostnameCoversWildcardDomain('a.example.com', '*.b.a.example.com')).toBe(true);
    expect(hostnameCoversWildcardDomain('x.a.example.com', '*.a.example.com')).toBe(false);
    expect(hostnameCoversWildcardDomain('ba.example.com', '*.a.example.com')).toBe(false);
  });
});
