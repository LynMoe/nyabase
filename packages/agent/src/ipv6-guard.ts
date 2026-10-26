import {
  AGENT_IPV6_GUARD_TABLE,
  MANAGED_NIC_HOST_NAME_PREFIX,
  type AgentHostStatus,
  type NodeMetricSample,
} from '@nyabase/common';
import { NftMonitorHub, recheckOnChanges, SystemNftRunner, type NftRunner, type RulesetChangeFeed } from './nft.js';

export type Ipv6GuardStatus = AgentHostStatus['ipv6Guard'];

/*
 * Guest IPv6 is disabled by dropping every IPv6 (and VLAN-tagged) frame on the
 * host-side veth of managed NICs. A bridge-family table needs no br_netfilter,
 * so it cannot collide with Docker's iptables FORWARD policy on the same host.
 */
export function renderIpv6GuardRuleset(): string {
  const guests = `"${MANAGED_NIC_HOST_NAME_PREFIX}*"`;
  return [
    `table bridge ${AGENT_IPV6_GUARD_TABLE}`,
    `delete table bridge ${AGENT_IPV6_GUARD_TABLE}`,
    `table bridge ${AGENT_IPV6_GUARD_TABLE} {`,
    '  chain forward {',
    '    type filter hook forward priority -200; policy accept;',
    `    iifname ${guests} ether type { ip6, 8021q, 8021ad } drop`,
    `    oifname ${guests} ether type { ip6, 8021q, 8021ad } drop`,
    '  }',
    '  chain input {',
    '    type filter hook input priority -200; policy accept;',
    `    iifname ${guests} ether type { ip6, 8021q, 8021ad } drop`,
    '  }',
    '  chain output {',
    '    type filter hook output priority -200; policy accept;',
    `    oifname ${guests} ether type { ip6, 8021q, 8021ad } drop`,
    '  }',
    '}',
    '',
  ].join('\n');
}

/** Does a listed table still drop guest IPv6 on every hook? */
export function guardTableIsComplete(listing: string): boolean {
  const drops = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(MANAGED_NIC_HOST_NAME_PREFIX) && line.includes('ip6') && line.endsWith('drop'));
  return ['hook forward', 'hook input', 'hook output'].every((hook) => listing.includes(hook))
    && drops.length >= 4;
}

/**
 * The agent's guest-IPv6 guarantee. `ensure` verifies the table and puts it
 * back when it is missing or incomplete. It runs at start, on a timer, on
 * every ruleset change `nft monitor` reports, and before any request that
 * would bring a guest NIC up; the agent refuses those while it fails.
 */
export class Ipv6Guard {
  private present = false;
  private lastError: string | null = 'not verified yet';
  private running: Promise<boolean> | undefined;
  private queued: Promise<boolean> | undefined;
  private readonly listeners = new Set<(status: Ipv6GuardStatus) => void>();

  constructor(private readonly nft: NftRunner = new SystemNftRunner()) {}

  /**
   * Verify (and if needed re-apply) the table. A call while a check runs
   * gets the next check, which starts after it: whatever prompted the call
   * (a ruleset change, a NIC about to come up) is never answered by a check
   * that may have listed the table before it happened.
   */
  ensure(): Promise<boolean> {
    if (!this.running) {
      this.running = this.check().finally(() => {
        this.running = undefined;
      });
      return this.running;
    }
    this.queued ??= this.running.then(() => {
      this.queued = undefined;
      return this.ensure();
    });
    return this.queued;
  }

  /**
   * Re-check after every ruleset change `feed` reports (with its own debounce
   * and back-off, see recheckOnChanges) until the returned function is called.
   */
  watch(feed: RulesetChangeFeed = new NftMonitorHub(this.nft)): () => void {
    // Failures only ever leave the guard absent, so verifying again is always this transition.
    return recheckOnChanges(feed, () => this.ensure(), (verified) => this.onChange((status) => {
      if (status.present) verified();
    }));
  }

  /** Called with the new status whenever presence or the error changes. */
  onChange(listener: (status: Ipv6GuardStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get error(): string | null {
    return this.lastError;
  }

  status(): Ipv6GuardStatus {
    return { present: this.present, error: this.lastError };
  }

  samples(): NodeMetricSample[] {
    return [{ name: 'nyabase_node_ipv6_guard_present', labels: {}, value: this.present ? 1 : 0 }];
  }

  private async check(): Promise<boolean> {
    let present = false;
    let error: string | null = null;
    try {
      const listing = await this.nft.listTable(AGENT_IPV6_GUARD_TABLE);
      if (!listing || !guardTableIsComplete(listing)) {
        await this.nft.apply(renderIpv6GuardRuleset());
      }
      const verified = await this.nft.listTable(AGENT_IPV6_GUARD_TABLE);
      present = Boolean(verified && guardTableIsComplete(verified));
      if (!present) error = 'guard table did not verify after apply';
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 512);
    }
    if (present !== this.present || error !== this.lastError) {
      this.present = present;
      this.lastError = error;
      const status = this.status();
      for (const listener of this.listeners) listener(status);
    }
    return present;
  }
}
