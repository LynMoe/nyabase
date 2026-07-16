import { describe, it, expect } from 'vitest';
import {
  cidrToIps,
  allocateNextIp,
  ipToNum,
  numToIp,
  canonicalIpv4Address,
  canonicalIpv4Cidr,
  ipv4CidrsOverlap,
  parseCidr,
  formatBytes,
  generateToken,
} from '@nyabase/common';

describe('ipToNum / numToIp', () => {
  it('converts well-known addresses', () => {
    expect(ipToNum('0.0.0.0')).toBe(0);
    expect(ipToNum('255.255.255.255')).toBe(0xffffffff);
    expect(ipToNum('192.168.1.1')).toBe(((192 << 24) | (168 << 16) | (1 << 8) | 1) >>> 0);
  });

  it('round-trips correctly', () => {
    const cases = ['10.0.0.1', '172.16.5.200', '192.168.100.254'];
    for (const ip of cases) {
      expect(numToIp(ipToNum(ip))).toBe(ip);
    }
  });

  it('throws on malformed IPv4', () => {
    expect(() => ipToNum('not.an.ip')).toThrow();
    expect(() => ipToNum('1.2.3')).toThrow();
    expect(() => ipToNum('1.2.3.256')).toThrow();
    expect(() => ipToNum('')).toThrow();
  });

  it('numToIp rejects out-of-range numbers', () => {
    expect(() => numToIp(-1)).toThrow();
    expect(() => numToIp(0x1_0000_0000)).toThrow();
    expect(() => numToIp(NaN)).toThrow();
  });
});

describe('canonical IPv4 network identity', () => {
  it('normalizes textual addresses and CIDR bases', () => {
    expect(canonicalIpv4Address('010.008.000.001')).toBe('10.8.0.1');
    expect(canonicalIpv4Cidr('10.8.1.12/16')).toBe('10.8.0.0/16');
  });

  it('detects equal and partially overlapping networks', () => {
    expect(ipv4CidrsOverlap('10.8.0.0/16', '10.8.1.0/24')).toBe(true);
    expect(ipv4CidrsOverlap('10.8.0.0/16', '10.9.0.0/16')).toBe(false);
  });
});

describe('parseCidr', () => {
  it('parses a well-formed CIDR', () => {
    expect(parseCidr('10.0.0.0/24')).toEqual({ base: '10.0.0.0', prefixLen: 24 });
  });

  it('throws on malformed CIDR', () => {
    expect(() => parseCidr('10.0.0.0')).toThrow();
    expect(() => parseCidr('10.0.0.0/33')).toThrow();
    expect(() => parseCidr('garbage/24')).toThrow();
  });
});

describe('cidrToIps', () => {
  it('returns correct count for /30 (2 usable hosts)', () => {
    expect(cidrToIps('10.0.0.0/30')).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('excludes reserved IPs', () => {
    const ips = cidrToIps('10.0.0.0/29', ['10.0.0.1', '10.0.0.3']);
    expect(ips).not.toContain('10.0.0.1');
    expect(ips).not.toContain('10.0.0.3');
    expect(ips).toContain('10.0.0.2');
    expect(ips).toContain('10.0.0.4');
  });

  it('returns empty for /31 (no usable host addresses)', () => {
    expect(cidrToIps('10.0.0.0/31')).toHaveLength(0);
  });

  it('returns empty for /32', () => {
    expect(cidrToIps('10.0.0.5/32')).toHaveLength(0);
  });

  it('handles /24 correctly (254 usable hosts)', () => {
    const ips = cidrToIps('192.168.1.0/24');
    expect(ips).toHaveLength(254);
    expect(ips[0]).toBe('192.168.1.1');
    expect(ips[253]).toBe('192.168.1.254');
  });

  it('throws on malformed CIDR', () => {
    expect(() => cidrToIps('bogus')).toThrow();
  });

  it('rejects huge materialization and invalid reservations without allocating', () => {
    expect(() => cidrToIps('0.0.0.0/0')).toThrow('too large');
    expect(() => cidrToIps('10.0.0.0/30', ['not-an-ip'])).toThrow('Invalid IPv4');
  });
});

describe('allocateNextIp', () => {
  it('returns first available IP', () => {
    const used = new Set(['192.168.1.1', '192.168.1.2']);
    expect(allocateNextIp('192.168.1.0/24', used)).toBe('192.168.1.3');
  });

  it('returns null when all IPs are used', () => {
    const ips = cidrToIps('10.0.0.0/30');
    expect(allocateNextIp('10.0.0.0/30', new Set(ips))).toBeNull();
  });

  it('skips reserved IPs', () => {
    expect(allocateNextIp('10.0.0.0/29', new Set(), ['10.0.0.1'])).toBe('10.0.0.2');
  });

  it('rejects an unbounded allocation range', () => {
    expect(() => allocateNextIp('0.0.0.0/0', new Set())).toThrow('too large');
  });
});

describe('formatBytes', () => {
  it('formats 0 and non-finite as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-100)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(Infinity)).toBe('0 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1024 ** 3)).toBe('1 GB');
  });

  it('respects decimal places', () => {
    expect(formatBytes(1536, 1)).toBe('1.5 KB');
  });

  it('falls back to the largest unit instead of crashing', () => {
    expect(formatBytes(1024 ** 6)).toMatch(/PB$/);
  });
});

describe('generateToken', () => {
  it('produces a hex string of correct length', () => {
    const token = generateToken(16);
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it('default byteLength produces 32 hex chars', () => {
    expect(generateToken()).toHaveLength(32);
  });

  it('rejects invalid byteLength', () => {
    expect(() => generateToken(0)).toThrow();
    expect(() => generateToken(-1)).toThrow();
    expect(() => generateToken(1.5)).toThrow();
  });

  it('generates different tokens on each call', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateToken()));
    expect(tokens.size).toBe(20);
  });
});
