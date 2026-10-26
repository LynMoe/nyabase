import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FIREWALL_MAX_CIDRS_PER_RULE,
  FIREWALL_MAX_PORT_RANGES_PER_RULE,
  FIREWALL_MAX_RULES_PER_SERVER,
  numToIp,
  zFirewallDocument,
  type FirewallDocument,
  type FirewallRuleSpec,
} from '@nyabase/common';
import { parseFirewallComment, renderFirewallRuleset } from './firewall-render.js';
import { renderIpv6GuardRuleset } from './ipv6-guard.js';

/*
 * The renderings against the real nft and kernel, each in a throwaway network
 * namespace (`unshare -n`), never the host's ruleset. Skipped where that is
 * not possible (no nft, not root).
 */
const scratch = mkdtempSync(join(tmpdir(), 'nyabase-agent-nft-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function isolatedNftWorks(): boolean {
  const probe = join(scratch, 'probe.nft');
  writeFileSync(probe, 'table bridge nyabase_probe\n');
  return spawnSync('unshare', ['-n', 'nft', '-f', probe], { stdio: 'ignore' }).status === 0;
}

/** Load `rulesets` one after the other into one fresh namespace; the listing after each. */
function loadInNamespace(...rulesets: string[]): string[] {
  const files = rulesets.map((ruleset, index) => {
    const file = join(scratch, `ruleset-${index}.nft`);
    writeFileSync(file, ruleset);
    return file;
  });
  const script = files
    .map((file) => `nft -c -f '${file}' && nft -f '${file}' && nft list table bridge nyabase_firewall && echo '-----'`)
    .join(' && ');
  return execFileSync('unshare', ['-n', 'sh', '-ec', script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('-----\n')
    .slice(0, rulesets.length);
}

const OWNER = '0123456789abcdef0123456789abcdef';

function largestDocument(): FirewallDocument {
  // The limits at once: 256 rules, 4081 of the 4096 CIDRs, 32 port ranges, every rule kind.
  const kinds: Array<Pick<FirewallRuleSpec, 'action' | 'protocol'>> = [
    { action: 'accept', protocol: 'tcp' },
    { action: 'reject', protocol: 'all' },
    { action: 'reject', protocol: 'udp' },
    { action: 'drop', protocol: 'all' },
  ];
  const rules: FirewallRuleSpec[] = [];
  for (let index = 0; index < FIREWALL_MAX_RULES_PER_SERVER; index += 1) {
    const kind = kinds[index % kinds.length]!;
    const cidrs = index < 15
      ? Array.from({ length: FIREWALL_MAX_CIDRS_PER_RULE }, (_, item) => `${numToIp(((10 << 24) >>> 0) + (index * FIREWALL_MAX_CIDRS_PER_RULE + item) * 4)}/31`)
      : [`${numToIp(((172 << 24) >>> 0) + index * 256)}/24`];
    const ports = kind.protocol === 'all'
      ? []
      : Array.from({ length: FIREWALL_MAX_PORT_RANGES_PER_RULE }, (_, item) => ({ from: 1000 + item * 10, to: 1000 + item * 10 + 4 }));
    rules.push({ ...kind, cidrs, ports });
  }
  return zFirewallDocument.parse({ digest: 'c'.repeat(64), rules });
}

describe.skipIf(!isolatedNftWorks())('firewall rulesets in real nft', () => {
  it('loads every rule kind, the empty document and the fail-closed table, and lists them stably', () => {
    const sample: FirewallDocument = {
      digest: 'a'.repeat(64),
      rules: [
        { action: 'accept', protocol: 'all', cidrs: ['10.0.0.0/9', '10.128.0.0/9', '192.168.1.5/32'], ports: [] },
        { action: 'reject', protocol: 'tcp', cidrs: ['10.0.0.0/8'], ports: [{ from: 22, to: 22 }, { from: 8000, to: 9000 }] },
        { action: 'reject', protocol: 'udp', cidrs: ['0.0.0.0/0'], ports: [{ from: 53, to: 53 }] },
        { action: 'reject', protocol: 'udp', cidrs: ['8.8.8.8/32'], ports: [] },
        { action: 'reject', protocol: 'all', cidrs: ['1.2.3.4/32'], ports: [] },
        { action: 'drop', protocol: 'udp', cidrs: ['1.2.3.0/24'], ports: [] },
        { action: 'drop', protocol: 'tcp', cidrs: ['1.2.4.0/24'], ports: [{ from: 1, to: 65535 }] },
        { action: 'drop', protocol: 'all', cidrs: ['1.2.3.0/25', '1.2.3.128/25'], ports: [] },
      ],
    };
    const rendered = renderFirewallRuleset(OWNER, sample);
    const [first, again, empty, closed] = loadInNamespace(
      rendered,
      rendered,
      renderFirewallRuleset(OWNER, { digest: 'b'.repeat(64), rules: [] }),
      renderFirewallRuleset('unknown', null),
    );
    expect(again).toBe(first);
    expect(parseFirewallComment(first!)).toEqual({ owner: OWNER, key: 'a'.repeat(64) });
    expect(first).toContain('hook prerouting');
    expect(first).toContain('reject with tcp reset');
    expect(first).toContain('reject with icmp admin-prohibited');
    expect(empty).toContain('ether type != { ip, arp } drop');
    expect(parseFirewallComment(closed!)).toEqual({ owner: 'unknown', key: 'fail-closed' });
    expect(closed).toContain('iifname "nyh*" drop');
  });

  it('loads the largest document the limits allow, next to the IPv6 guard', () => {
    const guard = join(scratch, 'guard.nft');
    writeFileSync(guard, renderIpv6GuardRuleset());
    const file = join(scratch, 'largest.nft');
    writeFileSync(file, renderFirewallRuleset(OWNER, largestDocument()));
    const listing = execFileSync('unshare', ['-n', 'sh', '-ec', `nft -f '${guard}' && nft -f '${file}' && nft list table bridge nyabase_firewall`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(parseFirewallComment(listing)).toEqual({ owner: OWNER, key: 'c'.repeat(64) });
    // Well under the 4 MiB the agent allows a listing.
    expect(Buffer.byteLength(listing)).toBeLessThan(4 * 1024 * 1024);
  });
});
