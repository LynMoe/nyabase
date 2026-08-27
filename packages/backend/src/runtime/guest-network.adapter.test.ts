import { describe, expect, it } from 'vitest';
import {
  buildGuestNetworkScript,
  parseCidrPrefix,
} from './guest-network.adapter.js';

describe('guest network adapter', () => {
  it('parses IPv4 CIDR prefixes', () => {
    expect(parseCidrPrefix('10.8.0.0/16')).toBe(16);
    expect(parseCidrPrefix('192.0.2.0/24')).toBe(24);
    expect(parseCidrPrefix('not-a-cidr')).toBeUndefined();
    expect(parseCidrPrefix('10.8.0.0/99')).toBeUndefined();
  });

  it('builds an idempotent iproute2 apply script', () => {
    const script = buildGuestNetworkScript({
      address: '10.8.96.200',
      prefixLength: 16,
      gateway: '10.8.0.1',
      dnsServers: ['1.1.1.1', '8.8.8.8'],
    });
    expect(script).toContain("ADDR='10.8.96.200/16'");
    expect(script).toContain("GW='10.8.0.1'");
    expect(script).toContain('ip addr replace "$ADDR" dev "$IFACE"');
    expect(script).toContain('ip route replace default via "$GW" dev "$IFACE"');
    expect(script).toContain('/etc/systemd/network/10-nyabase-eth0.network');
    expect(script).toContain("Address=$ADDR");
    expect(script).toContain('nameserver 1.1.1.1');
    expect(script).toContain('nameserver 8.8.8.8');
  });

  it('rejects malformed addresses', () => {
    expect(() => buildGuestNetworkScript({
      address: '10.8.96.200/16',
      prefixLength: 16,
      gateway: '10.8.0.1',
      dnsServers: [],
    })).toThrow('invalid_guest_ipv4');
  });
});
