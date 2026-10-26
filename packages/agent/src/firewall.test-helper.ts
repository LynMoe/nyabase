import type { FirewallDocument } from '@nyabase/common';
import type { StoredFirewallRead } from './firewall-store.js';
import { FirewallStore } from './firewall-store.js';
import type { NftMonitor, NftRunner } from './nft.js';

/**
 * nft in memory: an applied ruleset "lists" as its body (what follows the
 * declare / delete lines), so a listing carries the comment and hooks the
 * agent checks for. Tests edit `tables` to simulate tampering.
 */
export class FakeNft implements NftRunner {
  readonly tables = new Map<string, string>();
  readonly applied: string[] = [];
  readonly checked: string[] = [];
  readonly monitors: Array<{ changed: () => void; exit: () => void; stopped: boolean }> = [];
  failApply: ((ruleset: string) => Error | undefined) | undefined;
  failCheck: ((ruleset: string) => Error | undefined) | undefined;
  /** Every apply is a ruleset change the monitor reports. */
  echoChanges = false;

  async apply(ruleset: string): Promise<void> {
    const failure = this.failApply?.(ruleset);
    if (failure) throw failure;
    this.applied.push(ruleset);
    const lines = ruleset.split('\n');
    const table = /^table bridge (\S+)$/.exec(lines[0] ?? '')?.[1];
    if (!table) throw new Error(`fake nft cannot parse ${lines[0]}`);
    this.tables.set(table, lines.slice(2).join('\n'));
    if (this.echoChanges) for (const monitor of this.monitors) monitor.changed();
  }

  async check(ruleset: string): Promise<void> {
    const failure = this.failCheck?.(ruleset);
    if (failure) throw failure;
    this.checked.push(ruleset);
  }

  async listTable(table: string): Promise<string | undefined> {
    return this.tables.get(table);
  }

  async monitor(changed: () => void, exit: () => void): Promise<NftMonitor> {
    const monitor = { changed, exit, stopped: false };
    this.monitors.push(monitor);
    return { stop: () => { monitor.stopped = true; } };
  }

  appliedTo(table: string): string[] {
    return this.applied.filter((ruleset) => ruleset.startsWith(`table bridge ${table}\n`));
  }
}

/** FirewallStore without a disk. */
export class MemoryFirewallStore extends FirewallStore {
  stored: { serverId: string; document: FirewallDocument } | undefined;
  readonly writes: Array<{ serverId: string; document: FirewallDocument }> = [];
  failWrite = false;

  constructor() {
    super('/nonexistent');
  }

  override async read(): Promise<StoredFirewallRead> {
    return this.stored
      ? { kind: 'document', serverId: this.stored.serverId, document: this.stored.document }
      : { kind: 'none', reason: 'nothing stored' };
  }

  override async write(serverId: string, document: FirewallDocument): Promise<void> {
    if (this.failWrite) throw new Error('ENOSPC');
    this.stored = { serverId, document };
    this.writes.push({ serverId, document });
  }
}

export const SERVER_ID = '0b6b2f5e-2f8f-4b64-8a8e-5f4c4c4c4c4c';
export const SERVER_HEX = SERVER_ID.replaceAll('-', '');
export const OTHER_SERVER_HEX = 'f'.repeat(32);

export function firewallDocument(digestChar: string, rules: FirewallDocument['rules'] = []): FirewallDocument {
  return { digest: digestChar.repeat(64), rules };
}
