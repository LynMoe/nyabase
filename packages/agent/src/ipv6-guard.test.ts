import { describe, expect, it } from 'vitest';
import { guardTableIsComplete, Ipv6Guard, renderIpv6GuardRuleset, type NftRunner } from './ipv6-guard.js';

const LISTING = `table bridge nyabase_guard {
	chain forward {
		type filter hook forward priority -200; policy accept;
		iifname "nyh*" ether type { ip6, 8021q, 8021ad } drop
		oifname "nyh*" ether type { ip6, 8021q, 8021ad } drop
	}

	chain input {
		type filter hook input priority -200; policy accept;
		iifname "nyh*" ether type { ip6, 8021q, 8021ad } drop
	}

	chain output {
		type filter hook output priority -200; policy accept;
		oifname "nyh*" ether type { ip6, 8021q, 8021ad } drop
	}
}
`;

class FakeNft implements NftRunner {
  table: string | undefined;
  applied: string[] = [];
  failApply = false;

  async apply(ruleset: string): Promise<void> {
    if (this.failApply) throw new Error('Operation not permitted');
    this.applied.push(ruleset);
    this.table = LISTING;
  }

  async listTable(): Promise<string | undefined> {
    return this.table;
  }
}

describe('IPv6 guard', () => {
  it('replaces the table atomically in one nft transaction', () => {
    const ruleset = renderIpv6GuardRuleset();
    expect(ruleset.indexOf('delete table bridge nyabase_guard'))
      .toBeGreaterThan(ruleset.indexOf('table bridge nyabase_guard'));
    expect(ruleset).toContain('iifname "nyh*" ether type { ip6, 8021q, 8021ad } drop');
    expect(ruleset).toContain('oifname "nyh*" ether type { ip6, 8021q, 8021ad } drop');
  });

  it('recognises a complete table and rejects a partial one', () => {
    expect(guardTableIsComplete(LISTING)).toBe(true);
    expect(guardTableIsComplete(LISTING.replace(/\tchain output[\s\S]*?\}\n/, ''))).toBe(false);
    expect(guardTableIsComplete(LISTING.replaceAll('drop', 'accept'))).toBe(false);
  });

  it('installs a missing table and reports it', async () => {
    const nft = new FakeNft();
    const guard = new Ipv6Guard(nft);
    await expect(guard.ensure()).resolves.toBe(true);
    expect(nft.applied).toHaveLength(1);
    expect(guard.samples()).toEqual([{ name: 'nyabase_node_ipv6_guard_present', labels: {}, value: 1 }]);
    await guard.ensure();
    expect(nft.applied).toHaveLength(1);
  });

  it('reports absence when nft cannot apply', async () => {
    const nft = new FakeNft();
    nft.failApply = true;
    const guard = new Ipv6Guard(nft);
    await expect(guard.ensure()).resolves.toBe(false);
    expect(guard.error).toContain('Operation not permitted');
    expect(guard.samples()[0]?.value).toBe(0);
  });
});
