import { describe, expect, it } from 'vitest';
import {
  canonicalFirewallCidrs,
  canonicalFirewallPorts,
  firewallAddressIntervals,
  firewallDigestInput,
  formatFirewallPorts,
  parseFirewallPorts,
  zCreateFirewallRuleRequest,
  zFirewallDocument,
  zPatchFirewallRuleRequest,
} from '../protocol/firewall.js';

describe('firewall rule normalization', () => {
  it('canonicalizes, deduplicates and sorts CIDRs, bare addresses as /32', () => {
    expect(canonicalFirewallCidrs(['10.1.2.3/8', '192.168.1.7', '10.0.0.0/8', ' 10.0.0.0/16 ']))
      .toEqual(['10.0.0.0/8', '10.0.0.0/16', '192.168.1.7/32']);
  });

  it('merges port ranges that overlap or touch', () => {
    expect(canonicalFirewallPorts([{ from: 8000, to: 9000 }, { from: 22, to: 22 }, { from: 23, to: 25 }, { from: 8500, to: 9100 }]))
      .toEqual([{ from: 22, to: 25 }, { from: 8000, to: 9100 }]);
  });

  it('merges address ranges into disjoint intervals', () => {
    expect(firewallAddressIntervals(['10.0.0.0/8', '10.1.0.0/16', '11.0.0.0/8', '192.168.0.1/32', '0.0.0.0/0'].slice(0, 4)))
      .toEqual([
        { first: '10.0.0.0', last: '11.255.255.255' },
        { first: '192.168.0.1', last: '192.168.0.1' },
      ]);
    expect(firewallAddressIntervals(['0.0.0.0/0'])).toEqual([{ first: '0.0.0.0', last: '255.255.255.255' }]);
  });

  it('parses and formats port text', () => {
    expect(parseFirewallPorts('22, 80，8000-9000')).toEqual([
      { from: 22, to: 22 }, { from: 80, to: 80 }, { from: 8000, to: 9000 },
    ]);
    expect(() => parseFirewallPorts('0')).toThrow();
    expect(() => parseFirewallPorts('9000-8000')).toThrow();
    expect(() => parseFirewallPorts('65536')).toThrow();
    expect(formatFirewallPorts([{ from: 22, to: 22 }, { from: 8000, to: 9000 }])).toBe('22, 8000-9000');
  });

  it('digests independently of key order', () => {
    expect(firewallDigestInput([{ action: 'drop', protocol: 'tcp', cidrs: ['10.0.0.0/8'], ports: [{ from: 1, to: 2 }] }]))
      .toBe(firewallDigestInput([{ ports: [{ to: 2, from: 1 }], cidrs: ['10.0.0.0/8'], protocol: 'tcp', action: 'drop' } as never]));
  });
});

describe('firewall schemas', () => {
  it('normalizes a create request and refuses ports on protocol all', () => {
    const parsed = zCreateFirewallRuleRequest.parse({
      name: ' lan ', priority: 10, action: 'reject', protocol: 'tcp',
      ports: [{ from: 25, to: 30 }, { from: 22, to: 24 }], cidrs: ['10.9.9.9/8'],
    });
    expect(parsed).toMatchObject({ name: 'lan', description: '', ports: [{ from: 22, to: 30 }], cidrs: ['10.0.0.0/8'], serverIds: [] });
    expect(zCreateFirewallRuleRequest.safeParse({
      name: 'x', priority: 1, action: 'drop', protocol: 'all', ports: [{ from: 1, to: 1 }], cidrs: ['1.1.1.1'],
    }).success).toBe(false);
    expect(zCreateFirewallRuleRequest.safeParse({
      name: 'x', priority: 0, action: 'drop', protocol: 'all', cidrs: ['1.1.1.1'],
    }).success).toBe(false);
    expect(zCreateFirewallRuleRequest.safeParse({ name: 'x', priority: 1, action: 'drop', protocol: 'all', cidrs: [] }).success).toBe(false);
  });

  it('requires a field on patch', () => {
    expect(zPatchFirewallRuleRequest.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(zPatchFirewallRuleRequest.safeParse({ expectedRevision: 1, priority: 5 }).success).toBe(true);
  });

  it('accepts only canonical documents on the agent side', () => {
    const rule = { action: 'drop', protocol: 'all', cidrs: ['10.0.0.0/8'], ports: [] };
    const digest = 'a'.repeat(64);
    expect(zFirewallDocument.safeParse({ digest, rules: [rule] }).success).toBe(true);
    expect(zFirewallDocument.safeParse({ digest, rules: [{ ...rule, cidrs: ['10.1.0.0/8'] }] }).success).toBe(false);
    expect(zFirewallDocument.safeParse({ digest, rules: [{ ...rule, cidrs: ['10.0.0.1'] }] }).success).toBe(false);
    expect(zFirewallDocument.safeParse({ digest, rules: [{ ...rule, ports: [{ from: 1, to: 2 }] }] }).success).toBe(false);
    expect(zFirewallDocument.safeParse({ digest: 'x', rules: [] }).success).toBe(false);
  });
});
