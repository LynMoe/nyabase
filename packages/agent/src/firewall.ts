import {
  AGENT_FIREWALL_TABLE,
  NodeMetricName,
  type AgentHostStatus,
  type FirewallDocument,
  type NodeMetricSample,
} from '@nyabase/common';
import {
  FAIL_CLOSED_KEY,
  firewallOwnerOf,
  parseFirewallComment,
  renderFirewallRuleset,
  UNKNOWN_FIREWALL_OWNER,
  type FirewallOwner,
} from './firewall-render.js';
import type { FirewallStore } from './firewall-store.js';
import {
  NftMonitorHub,
  NftRefusedError,
  recheckOnChanges,
  SystemNftRunner,
  type NftRunner,
  type RulesetChangeFeed,
} from './nft.js';

export type FirewallStatus = AgentHostStatus['firewall'];

/** nft refused the rendering of a document in a dry run: the document itself is the problem. */
export class FirewallDocumentRefusedError extends Error {}

/** Which table `restore` left in place. */
export type FirewallRestoreResult = 'document' | 'fail-closed' | 'none';

export interface GuestFirewallOptions {
  readonly store: FirewallStore;
  readonly nft?: NftRunner;
  /** The server the agent's credential names; omitted before enrollment. */
  readonly serverId?: string;
  readonly log?: (message: string) => void;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause)).slice(0, 512);

/**
 * The guest egress firewall: the document the Backend last sent (persisted,
 * see firewall-store.ts) rendered into `bridge nyabase_firewall`, or the
 * fail-closed table while the agent has none.
 *
 * - Verifying compares a fresh listing byte for byte with the one taken right
 *   after the current document was last applied (nft normalizes, and is
 *   stable on one host); any other listing, or none, re-applies it.
 * - Active applies (restore at start, `firewall.apply`, a new server id)
 *   always write the table. Passive checks (timer, monitor, a NIC coming up)
 *   rewrite a missing table or one this server (or nobody) wrote, but never
 *   one another server id wrote: two agents on a host must show up, not
 *   overwrite each other forever.
 * - `present` additionally needs the Backend to have sent the document on the
 *   current control connection (resetConfirmation on every connect and
 *   disconnect), so rules added while the agent was away are never bypassed
 *   by the document it kept.
 * - All nft work runs one operation at a time, in arrival order.
 */
export class GuestFirewall {
  private readonly nft: NftRunner;
  private readonly store: FirewallStore;
  private readonly log: (message: string) => void;
  private owner: FirewallOwner;
  private document: FirewallDocument | null = null;
  /** The server id `document` was sent to. */
  private documentOwner: FirewallOwner | null = null;
  /** The listing right after the last successful apply, and what that apply rendered. */
  private snapshot: { readonly owner: FirewallOwner; readonly key: string; readonly listing: string } | undefined;
  /** The table holds the current rendering (document or fail-closed) as of the last check. */
  private verified = false;
  private confirmed = false;
  private epoch = 0;
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingCheck: Promise<boolean> | undefined;
  private published = '';
  private readonly listeners = new Set<(status: FirewallStatus) => void>();
  private readonly verifiedListeners = new Set<() => void>();

  constructor(options: GuestFirewallOptions) {
    this.nft = options.nft ?? new SystemNftRunner();
    this.store = options.store;
    this.log = options.log ?? (() => undefined);
    this.owner = firewallOwnerOf(options.serverId);
    this.published = JSON.stringify(this.status());
  }

  /** The known document is in place and the Backend confirmed it on this connection. */
  get present(): boolean {
    return this.document !== null && this.verified && this.confirmed && this.snapshotKey() === this.document.digest;
  }

  /** Why NICs are refused right now, or null when `present`. */
  get refusal(): string | null {
    if (this.present) return null;
    if (this.lastError) return this.lastError;
    if (!this.document) return 'the agent has no firewall document yet, guest egress stays closed until the Backend sends one';
    if (!this.confirmed) return 'the Backend has not sent the firewall document on this connection yet';
    return 'the firewall table is not verified yet';
  }

  status(): FirewallStatus {
    return { present: this.present, digest: this.document?.digest ?? null, error: this.lastError };
  }

  samples(): NodeMetricSample[] {
    return [{ name: NodeMetricName.FirewallPresent, labels: {}, value: this.present ? 1 : 0 }];
  }

  /** Called with the new status whenever it changes. */
  onChange(listener: (status: FirewallStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Load the persisted document and write its table (or the fail-closed one
   * when there is none, it is unusable, or it does not apply). At start, before
   * anything else, and by `guest-guards` before Incus starts.
   */
  restore(): Promise<FirewallRestoreResult> {
    return this.enqueue(async () => {
      const stored = await this.store.read();
      if (stored.kind === 'none') {
        this.useDocument(null, null);
        this.log(`no firewall document (${stored.reason}): guest egress stays closed until the Backend sends one`);
      } else if (stored.serverId !== this.owner) {
        this.useDocument(null, null);
        this.log(`${this.store.path} was written for server ${stored.serverId}, not ${this.owner}: ignoring it, guest egress stays closed`);
      } else {
        this.useDocument(stored.document, stored.serverId);
      }
      await this.verify('active');
      if (this.verified) return this.document ? 'document' : 'fail-closed';
      if (!this.document) return 'none';
      const failure = this.lastError;
      try {
        await this.install(null);
        this.settle(false, `the stored firewall document did not apply, guest egress is closed: ${failure ?? 'unknown error'}`);
        return 'fail-closed';
      } catch (cause) {
        this.settle(false, message(cause));
        return 'none';
      }
    });
  }

  /**
   * The Backend's `firewall.apply`, already validated: dry-run it, persist it,
   * then apply and verify. A document nft refuses changes nothing (the old
   * table and document stay). The same digest as the current document only
   * re-verifies, which rewrites nothing while the table is intact.
   */
  apply(document: FirewallDocument): Promise<void> {
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (this.owner === UNKNOWN_FIREWALL_OWNER) throw new Error('the agent does not know its server id yet');
      if (this.document?.digest !== document.digest || this.documentOwner !== this.owner) {
        try {
          await this.nft.check(renderFirewallRuleset(this.owner, document));
        } catch (cause) {
          if (cause instanceof NftRefusedError) throw new FirewallDocumentRefusedError(`nft refused the firewall document: ${cause.message}`);
          throw cause;
        }
        await this.store.write(this.owner, document);
        this.useDocument(document, this.owner);
      }
      // A request that outlived its connection confirms nothing on the next one.
      if (epoch === this.epoch) this.confirmed = true;
      await this.verify('active');
      if (!this.verified) throw new Error(`the firewall document did not apply: ${this.lastError ?? 'unknown error'}`);
      if (!this.confirmed) throw new Error('the control connection this firewall document came on has ended');
    });
  }

  /** A new control connection, or the end of one: the document needs the Backend's word again. */
  resetConfirmation(): void {
    this.epoch += 1;
    this.confirmed = false;
    this.publish();
  }

  /** The credential (re-enrollment) names this server now. */
  setServerId(serverId: string): Promise<void> {
    const owner = firewallOwnerOf(serverId);
    return this.enqueue(async () => {
      if (owner === this.owner) return;
      this.owner = owner;
      // A document sent to another server is not this server's.
      if (this.documentOwner !== owner) this.useDocument(null, null);
      await this.verify('active');
    });
  }

  /**
   * Passive check (timer, monitor, a NIC about to come up): verify, rewrite
   * if needed and allowed, and answer whether guest NICs may come up. A call
   * while a check runs gets the next check, which starts after it.
   */
  async ensure(): Promise<boolean> {
    await this.check();
    return this.present;
  }

  /** Re-check after every ruleset change `feed` reports, until the returned function is called. */
  watch(feed: RulesetChangeFeed = new NftMonitorHub(this.nft)): () => void {
    return recheckOnChanges(feed, () => this.check(), (listener) => {
      this.verifiedListeners.add(listener);
      return () => this.verifiedListeners.delete(listener);
    });
  }

  /** Whether the table holds the current rendering (fail-closed included). */
  private check(): Promise<boolean> {
    if (this.pendingCheck) return this.pendingCheck;
    const pending: Promise<boolean> = this.enqueue(async () => {
      if (this.pendingCheck === pending) this.pendingCheck = undefined;
      await this.verify('passive');
      return this.verified;
    });
    this.pendingCheck = pending;
    return pending;
  }

  private async verify(mode: 'active' | 'passive'): Promise<void> {
    try {
      const listing = await this.nft.listTable(AGENT_FIREWALL_TABLE);
      const key = this.document?.digest ?? FAIL_CLOSED_KEY;
      const snapshot = this.snapshot;
      if (listing !== undefined && snapshot?.owner === this.owner && snapshot.key === key && snapshot.listing === listing) {
        this.settle(true, null);
        return;
      }
      if (listing !== undefined && mode === 'passive') {
        const claimed = parseFirewallComment(listing);
        if (claimed && claimed.owner !== UNKNOWN_FIREWALL_OWNER && claimed.owner !== this.owner) {
          this.settle(false, `${AGENT_FIREWALL_TABLE} is owned by server ${claimed.owner}`);
          return;
        }
      }
      await this.install(this.document);
      this.settle(true, null);
    } catch (cause) {
      this.settle(false, message(cause));
    }
  }

  /** Write the table for `document` (null: fail-closed) and take the snapshot later checks compare with. */
  private async install(document: FirewallDocument | null): Promise<void> {
    const key = document?.digest ?? FAIL_CLOSED_KEY;
    this.snapshot = undefined;
    await this.nft.apply(renderFirewallRuleset(this.owner, document));
    const listing = await this.nft.listTable(AGENT_FIREWALL_TABLE);
    const claimed = listing === undefined ? null : parseFirewallComment(listing);
    if (listing === undefined || claimed?.owner !== this.owner || claimed.key !== key || !listing.includes('hook prerouting')) {
      throw new Error(`${AGENT_FIREWALL_TABLE} did not verify after apply`);
    }
    this.snapshot = { owner: this.owner, key, listing };
  }

  private useDocument(document: FirewallDocument | null, owner: FirewallOwner | null): void {
    this.document = document;
    this.documentOwner = owner;
    // Whatever was verified belonged to the previous document.
    this.snapshot = undefined;
    this.verified = false;
    this.publish();
  }

  private snapshotKey(): string | undefined {
    return this.snapshot?.owner === this.owner ? this.snapshot.key : undefined;
  }

  private settle(verified: boolean, error: string | null): void {
    const before = this.verified;
    this.verified = verified;
    // The status schema caps it: a longer error would make hello / status frames unparsable.
    this.lastError = error === null ? null : error.slice(0, 512);
    this.publish();
    if (verified && !before) for (const listener of [...this.verifiedListeners]) listener();
  }

  private publish(): void {
    const status = this.status();
    const serialized = JSON.stringify(status);
    if (serialized === this.published) return;
    this.published = serialized;
    for (const listener of [...this.listeners]) listener(status);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
