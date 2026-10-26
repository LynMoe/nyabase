import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_FIREWALL_TABLE,
  AGENT_IPV6_GUARD_TABLE,
  NODE_METRIC_CATALOG,
  zAgentHostStatus,
  type FirewallDocument,
} from '@nyabase/common';
import {
  FAIL_CLOSED_KEY,
  firewallComment,
  firewallOwnerOf,
  parseFirewallComment,
  renderFirewallRule,
  renderFirewallRuleset,
} from './firewall-render.js';
import { FirewallDocumentRefusedError, GuestFirewall } from './firewall.js';
import {
  FakeNft,
  firewallDocument,
  MemoryFirewallStore,
  OTHER_SERVER_HEX,
  SERVER_HEX,
  SERVER_ID,
} from './firewall.test-helper.js';
import { Ipv6Guard } from './ipv6-guard.js';
import { NftMonitorHub, NftRefusedError } from './nft.js';

const SAMPLE: FirewallDocument = {
  digest: 'a'.repeat(64),
  rules: [
    { action: 'accept', protocol: 'all', cidrs: ['10.0.0.0/9', '10.0.0.5/32', '10.128.0.0/9', '192.168.1.5/32'], ports: [] },
    { action: 'reject', protocol: 'tcp', cidrs: ['10.0.0.0/8'], ports: [{ from: 22, to: 22 }, { from: 8000, to: 9000 }] },
    { action: 'reject', protocol: 'udp', cidrs: ['0.0.0.0/0'], ports: [{ from: 53, to: 53 }] },
    { action: 'reject', protocol: 'all', cidrs: ['1.2.3.4/32'], ports: [] },
    { action: 'drop', protocol: 'udp', cidrs: ['1.2.3.0/24'], ports: [] },
    { action: 'drop', protocol: 'all', cidrs: ['1.2.3.0/25', '1.2.3.128/25'], ports: [] },
  ],
};

const SAMPLE_RULESET = `table bridge nyabase_firewall
delete table bridge nyabase_firewall
table bridge nyabase_firewall {
  comment "nyabase egress server=${SERVER_HEX} digest=${'a'.repeat(64)}"
  chain egress {
    type filter hook prerouting priority -190; policy accept;
    iifname != "nyh*" accept
    iifname "nyh*" ether type != { ip, arp } drop
    ip daddr { 10.0.0.0-10.255.255.255, 192.168.1.5 } accept
    ip daddr { 10.0.0.0-10.255.255.255 } meta l4proto tcp tcp dport { 22, 8000-9000 } reject with tcp reset
    ip daddr { 0.0.0.0-255.255.255.255 } meta l4proto udp udp dport { 53 } reject with icmp type port-unreachable
    ip daddr { 1.2.3.4 } meta l4proto tcp reject with tcp reset
    ip daddr { 1.2.3.4 } reject with icmp type admin-prohibited
    ip daddr { 1.2.3.0-1.2.3.255 } meta l4proto udp drop
    ip daddr { 1.2.3.0-1.2.3.255 } drop
  }
}
`;

function setup(options: { serverId?: string } = { serverId: SERVER_ID }) {
  const nft = new FakeNft();
  const store = new MemoryFirewallStore();
  const firewall = new GuestFirewall({ nft, store, serverId: options.serverId });
  return { nft, store, firewall };
}

const firewallApplies = (nft: FakeNft): string[] => nft.appliedTo(AGENT_FIREWALL_TABLE);

describe('firewall rendering', () => {
  it('renders every rule kind in order, with merged address intervals', () => {
    expect(renderFirewallRuleset(SERVER_HEX, SAMPLE)).toBe(SAMPLE_RULESET);
  });

  it('splits reject on every protocol into a TCP reset and an ICMP error', () => {
    expect(renderFirewallRule({ action: 'reject', protocol: 'all', cidrs: ['8.8.8.8/32'], ports: [] })).toEqual([
      'ip daddr { 8.8.8.8 } meta l4proto tcp reject with tcp reset',
      'ip daddr { 8.8.8.8 } reject with icmp type admin-prohibited',
    ]);
    expect(renderFirewallRule({ action: 'reject', protocol: 'udp', cidrs: ['8.8.8.8/32'], ports: [] }))
      .toEqual(['ip daddr { 8.8.8.8 } meta l4proto udp reject with icmp type port-unreachable']);
    expect(renderFirewallRule({ action: 'accept', protocol: 'tcp', cidrs: ['8.8.8.0/24', '8.8.9.0/24'], ports: [{ from: 443, to: 443 }] }))
      .toEqual([
        'ip daddr { 8.8.8.0-8.8.9.255 } meta l4proto tcp tcp dport { 443 } accept',
        'ip daddr { 8.8.8.0-8.8.9.255 } ip frag-off & 0x1fff != 0 meta l4proto tcp accept',
      ]);
    expect(renderFirewallRule({ action: 'drop', protocol: 'udp', cidrs: ['8.8.8.8/32'], ports: [{ from: 53, to: 53 }] }))
      .toEqual(['ip daddr { 8.8.8.8 } meta l4proto udp udp dport { 53 } drop']);
  });

  it('keeps an empty document open but fails closed without one', () => {
    const empty = renderFirewallRuleset(SERVER_HEX, firewallDocument('b'));
    expect(empty).toContain('iifname != "nyh*" accept\n    iifname "nyh*" ether type != { ip, arp } drop\n  }');
    const closed = renderFirewallRuleset('unknown', null);
    expect(closed).toContain('comment "nyabase egress server=unknown digest=fail-closed"');
    expect(closed).toContain('    type filter hook prerouting priority -190; policy accept;\n    iifname "nyh*" drop\n  }');
    expect(closed).not.toContain('accept\n    iifname');
  });

  it('replaces the table in one transaction', () => {
    const lines = SAMPLE_RULESET.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      'table bridge nyabase_firewall',
      'delete table bridge nyabase_firewall',
      'table bridge nyabase_firewall {',
    ]);
  });

  it('writes and reads ownership comments within the nft comment limit', () => {
    const comment = firewallComment(SERVER_HEX, 'f'.repeat(64));
    expect(comment.length).toBeLessThanOrEqual(128);
    expect(parseFirewallComment(`table bridge x {\n\tcomment "${comment}"\n}`)).toEqual({ owner: SERVER_HEX, key: 'f'.repeat(64) });
    expect(parseFirewallComment(`comment "${firewallComment('unknown', FAIL_CLOSED_KEY)}"`)).toEqual({ owner: 'unknown', key: FAIL_CLOSED_KEY });
    expect(parseFirewallComment('comment "someone else"')).toBeNull();
    expect(firewallOwnerOf(SERVER_ID)).toBe(SERVER_HEX);
    expect(firewallOwnerOf(undefined)).toBe('unknown');
    expect(firewallOwnerOf('not-an-id')).toBe('unknown');
  });
});

describe('guest firewall', () => {
  it('fails closed at start without a stored document', async () => {
    const { nft, firewall } = setup();
    await expect(firewall.restore()).resolves.toBe('fail-closed');
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain('iifname "nyh*" drop');
    expect(firewall.status()).toEqual({ present: false, digest: null, error: null });
    await expect(firewall.ensure()).resolves.toBe(false);
    expect(firewall.refusal).toContain('no firewall document');
  });

  it('restores the stored document but needs the Backend to confirm it on this connection', async () => {
    const { nft, store, firewall } = setup();
    store.stored = { serverId: SERVER_HEX, document: SAMPLE };
    await expect(firewall.restore()).resolves.toBe('document');
    expect(firewallApplies(nft)).toEqual([SAMPLE_RULESET]);
    expect(firewall.status()).toEqual({ present: false, digest: SAMPLE.digest, error: null });
    expect(firewall.refusal).toContain('has not sent');
    // The same digest only confirms: nothing is dry-run, stored or applied again.
    await firewall.apply(SAMPLE);
    expect(firewall.status().present).toBe(true);
    expect(nft.checked).toEqual([]);
    expect(store.writes).toEqual([]);
    expect(firewallApplies(nft)).toHaveLength(1);
    await expect(firewall.ensure()).resolves.toBe(true);
    expect(firewallApplies(nft)).toHaveLength(1);
  });

  it('reports presence as a gauge once the metric catalog lists it', async () => {
    const { firewall } = setup();
    await firewall.restore();
    await firewall.apply(SAMPLE);
    const listed = 'nyabase_node_firewall_present' in NODE_METRIC_CATALOG.definitions;
    expect(firewall.samples()).toEqual(listed ? [{ name: 'nyabase_node_firewall_present', labels: {}, value: 1 }] : []);
  });

  it('ignores a document stored for another server', async () => {
    const { nft, store, firewall } = setup();
    store.stored = { serverId: OTHER_SERVER_HEX, document: SAMPLE };
    await expect(firewall.restore()).resolves.toBe('fail-closed');
    expect(firewall.status().digest).toBeNull();
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain('digest=fail-closed');
  });

  it('falls back to the fail-closed table when the stored document does not apply', async () => {
    const { nft, store, firewall } = setup();
    store.stored = { serverId: SERVER_HEX, document: SAMPLE };
    nft.failApply = (ruleset) => (ruleset.includes('digest=fail-closed') ? undefined : new Error('Could not process rule'));
    await expect(firewall.restore()).resolves.toBe('fail-closed');
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain('digest=fail-closed');
    expect(firewall.status()).toMatchObject({ present: false, digest: SAMPLE.digest });
    expect(firewall.status().error).toContain('Could not process rule');
    // nft echoes refused rules at length: the error still fits the status frame the Backend parses.
    nft.failApply = (ruleset) => (ruleset.includes('digest=fail-closed') ? undefined : new Error('x'.repeat(4096)));
    await firewall.restore();
    expect(zAgentHostStatus.safeParse({ ipv6Guard: { present: true, error: null }, firewall: firewall.status() }).success)
      .toBe(true);
    // Later checks keep trying the stored document.
    nft.failApply = undefined;
    await firewall.apply(SAMPLE);
    expect(firewall.status()).toEqual({ present: true, digest: SAMPLE.digest, error: null });
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain(`digest=${SAMPLE.digest}`);
  });

  it('dry-runs a new document and keeps the old one when nft refuses it', async () => {
    const { nft, store, firewall } = setup();
    await firewall.restore();
    await firewall.apply(SAMPLE);
    const next = firewallDocument('c');
    nft.failCheck = () => new NftRefusedError('nft exited with 1: Error: syntax error');
    await expect(firewall.apply(next)).rejects.toBeInstanceOf(FirewallDocumentRefusedError);
    expect(store.writes.map((write) => write.document.digest)).toEqual([SAMPLE.digest]);
    expect(firewall.status()).toEqual({ present: true, digest: SAMPLE.digest, error: null });
    // nft not running at all is not the document's fault.
    nft.failCheck = () => new Error('nft is not installed');
    await expect(firewall.apply(next)).rejects.not.toBeInstanceOf(FirewallDocumentRefusedError);
  });

  it('persists a new document before applying it, and keeps it when the apply fails', async () => {
    const { nft, store, firewall } = setup();
    await firewall.restore();
    await firewall.apply(SAMPLE);
    const next = firewallDocument('d');
    nft.failApply = () => new Error('Operation not permitted');
    await expect(firewall.apply(next)).rejects.toThrow('did not apply');
    expect(store.stored?.document.digest).toBe(next.digest);
    // The kernel kept the old table, but it is not the current document's: never verified.
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain(`digest=${SAMPLE.digest}`);
    await expect(firewall.ensure()).resolves.toBe(false);
    expect(firewall.status()).toEqual({ present: false, digest: next.digest, error: 'Operation not permitted' });
    nft.failApply = undefined;
    await expect(firewall.ensure()).resolves.toBe(true);
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain(`digest=${next.digest}`);
  });

  it('puts back a tampered or missing table, but leaves one another server wrote', async () => {
    const { nft, firewall } = setup();
    await firewall.restore();
    await firewall.apply(SAMPLE);
    nft.tables.set(AGENT_FIREWALL_TABLE, nft.tables.get(AGENT_FIREWALL_TABLE)!.replace(' drop\n  }', ' accept\n  }'));
    await expect(firewall.ensure()).resolves.toBe(true);
    expect(firewallApplies(nft)).toHaveLength(3);
    nft.tables.delete(AGENT_FIREWALL_TABLE);
    await expect(firewall.ensure()).resolves.toBe(true);
    expect(firewallApplies(nft)).toHaveLength(4);
    // A second agent (another server id) on this host wrote the table.
    const foreign = renderFirewallRuleset(OTHER_SERVER_HEX, firewallDocument('e')).split('\n').slice(2).join('\n');
    nft.tables.set(AGENT_FIREWALL_TABLE, foreign);
    await expect(firewall.ensure()).resolves.toBe(false);
    expect(firewallApplies(nft)).toHaveLength(4);
    expect(firewall.status()).toEqual({
      present: false,
      digest: SAMPLE.digest,
      error: `nyabase_firewall is owned by server ${OTHER_SERVER_HEX}`,
    });
    // One written before enrollment is this agent's to replace.
    nft.tables.set(AGENT_FIREWALL_TABLE, renderFirewallRuleset('unknown', null).split('\n').slice(2).join('\n'));
    await expect(firewall.ensure()).resolves.toBe(true);
    // The Backend's apply always takes over.
    nft.tables.set(AGENT_FIREWALL_TABLE, foreign);
    await firewall.apply(SAMPLE);
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain(`server=${SERVER_HEX}`);
  });

  it('counts the confirmation per control connection', async () => {
    const { firewall } = setup();
    await firewall.restore();
    await firewall.apply(SAMPLE);
    const changes = vi.fn();
    firewall.onChange(changes);
    firewall.resetConfirmation();
    expect(firewall.status().present).toBe(false);
    expect(changes).toHaveBeenLastCalledWith({ present: false, digest: SAMPLE.digest, error: null });
    await expect(firewall.ensure()).resolves.toBe(false);
    // An apply from the connection that ended confirms nothing on the next one.
    const stale = firewall.apply(SAMPLE);
    firewall.resetConfirmation();
    await expect(stale).rejects.toThrow('connection');
    expect(firewall.status().present).toBe(false);
    await firewall.apply(SAMPLE);
    expect(firewall.status().present).toBe(true);
  });

  it('applies concurrent documents one at a time, in arrival order', async () => {
    const { nft, store, firewall } = setup();
    await firewall.restore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowCheck = nft.check.bind(nft);
    nft.check = async (ruleset) => {
      if (ruleset.includes(`digest=${'1'.repeat(64)}`)) await gate;
      return slowCheck(ruleset);
    };
    const first = firewall.apply(firewallDocument('1'));
    const second = firewall.apply(firewallDocument('2'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.writes).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(store.writes.map((write) => write.document.digest[0])).toEqual(['1', '2']);
    expect(firewall.status()).toEqual({ present: true, digest: '2'.repeat(64), error: null });
  });

  it('drops a document of another server when the credential changes', async () => {
    const { nft, store, firewall } = setup({ serverId: undefined });
    store.stored = { serverId: SERVER_HEX, document: SAMPLE };
    await expect(firewall.restore()).resolves.toBe('fail-closed');
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain('server=unknown digest=fail-closed');
    await expect(firewall.apply(SAMPLE)).rejects.toThrow('server id');
    await firewall.setServerId(SERVER_ID);
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain(`server=${SERVER_HEX} digest=fail-closed`);
    await firewall.apply(SAMPLE);
    expect(firewall.status().present).toBe(true);
    await firewall.setServerId('11111111-1111-4111-8111-111111111111');
    expect(firewall.status()).toEqual({ present: false, digest: null, error: null });
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain('server=11111111111141118111111111111111 digest=fail-closed');
  });
});

describe('shared nft monitor', () => {
  it('runs one monitor for the guard and the firewall, with separate back-off', async () => {
    vi.useFakeTimers();
    try {
      const nft = new FakeNft();
      const store = new MemoryFirewallStore();
      const guard = new Ipv6Guard(nft);
      const firewall = new GuestFirewall({ nft, store, serverId: SERVER_ID });
      await guard.ensure();
      await firewall.restore();
      await firewall.apply(SAMPLE);
      const hub = new NftMonitorHub(nft);
      const stopGuard = guard.watch(hub);
      const stopFirewall = firewall.watch(hub);
      await vi.advanceTimersByTimeAsync(0);
      expect(nft.monitors).toHaveLength(1);
      // The firewall table now applies but never verifies, and every apply echoes back.
      nft.echoChanges = true;
      const realApply = nft.apply.bind(nft);
      nft.apply = async (ruleset) => {
        await realApply(ruleset);
        if (ruleset.startsWith(`table bridge ${AGENT_FIREWALL_TABLE}`)) nft.tables.set(AGENT_FIREWALL_TABLE, 'table bridge nyabase_firewall { }');
      };
      nft.tables.delete(AGENT_FIREWALL_TABLE);
      nft.monitors[0]!.changed();
      await vi.advanceTimersByTimeAsync(60_000);
      const firewallAttempts = nft.appliedTo(AGENT_FIREWALL_TABLE).length;
      expect(firewallAttempts).toBeGreaterThan(3);
      expect(firewallAttempts).toBeLessThan(14);
      expect(firewall.status().present).toBe(false);
      // The guard's checks are not slowed down by the firewall's failures.
      const guardApplies = nft.appliedTo(AGENT_IPV6_GUARD_TABLE).length;
      nft.tables.delete(AGENT_IPV6_GUARD_TABLE);
      nft.monitors[0]!.changed();
      await vi.advanceTimersByTimeAsync(250);
      expect(nft.appliedTo(AGENT_IPV6_GUARD_TABLE)).toHaveLength(guardApplies + 1);
      expect(guard.status().present).toBe(true);
      // A monitor that ends is restarted once, for both.
      nft.monitors[0]!.exit();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(nft.monitors).toHaveLength(2);
      stopGuard();
      expect(nft.monitors[1]!.stopped).toBe(false);
      stopFirewall();
      expect(nft.monitors[1]!.stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
