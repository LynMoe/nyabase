import { describe, expect, it, vi } from 'vitest';
import {
  guardTableIsComplete,
  Ipv6Guard,
  renderIpv6GuardRuleset,
  type NftMonitor,
  type NftRunner,
} from './ipv6-guard.js';

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
  lists = 0;
  monitors: Array<{ changed: () => void; exit: () => void; stopped: boolean }> = [];

  async apply(ruleset: string): Promise<void> {
    if (this.failApply) throw new Error('Operation not permitted');
    this.applied.push(ruleset);
    this.table = LISTING;
  }

  async listTable(): Promise<string | undefined> {
    this.lists += 1;
    return this.table;
  }

  async monitor(changed: () => void, exit: () => void): Promise<NftMonitor> {
    const monitor = { changed, exit, stopped: false };
    this.monitors.push(monitor);
    return { stop: () => { monitor.stopped = true; } };
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

  it('reports status changes, not every check', async () => {
    const nft = new FakeNft();
    const guard = new Ipv6Guard(nft);
    const changes = vi.fn();
    guard.onChange(changes);
    expect(guard.status()).toEqual({ ipv6Guard: { present: false, error: 'not verified yet' } });
    await guard.ensure();
    await guard.ensure();
    expect(changes.mock.calls).toEqual([[{ ipv6Guard: { present: true, error: null } }]]);
    nft.table = undefined;
    nft.failApply = true;
    await guard.ensure();
    expect(changes).toHaveBeenLastCalledWith({ ipv6Guard: { present: false, error: 'Operation not permitted' } });
  });

  it('answers a call made during a check with a check that starts after it', async () => {
    const nft = new FakeNft();
    nft.table = LISTING;
    const guard = new Ipv6Guard(nft);
    const first = guard.ensure();
    // The table vanishes after the running check listed it as complete.
    nft.table = undefined;
    const second = guard.ensure();
    const third = guard.ensure();
    expect(third).toBe(second);
    await expect(first).resolves.toBe(false);
    // The follow-up check ran on its own and put the table back.
    await expect(second).resolves.toBe(true);
    expect(nft.applied).toHaveLength(1);
  });

  it('re-checks after ruleset changes and restarts a monitor that ended', async () => {
    vi.useFakeTimers();
    try {
      const nft = new FakeNft();
      const guard = new Ipv6Guard(nft);
      await guard.ensure();
      const stop = guard.watch();
      await vi.advanceTimersByTimeAsync(0);
      expect(nft.monitors).toHaveLength(1);
      // `nft flush ruleset`: a burst of events, one check that puts the table back.
      nft.table = undefined;
      nft.monitors[0]!.changed();
      nft.monitors[0]!.changed();
      await vi.advanceTimersByTimeAsync(250);
      expect(nft.applied).toHaveLength(2);
      expect(guard.status().ipv6Guard.present).toBe(true);
      nft.monitors[0]!.exit();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(nft.monitors).toHaveLength(2);
      stop();
      expect(nft.monitors[1]!.stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
