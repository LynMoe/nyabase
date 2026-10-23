import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AGENT_IPV6_GUARD_TABLE,
  MANAGED_NIC_HOST_NAME_PREFIX,
  type AgentHostStatus,
  type NodeMetricSample,
} from '@nyabase/common';

const execFile = promisify(execFileCallback);
const NFT_TIMEOUT_MS = 5_000;
const NFT_BINARIES = ['/usr/sbin/nft', '/sbin/nft', 'nft'] as const;

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

export interface NftMonitor {
  stop(): void;
}

export interface NftRunner {
  apply(ruleset: string): Promise<void>;
  listTable(): Promise<string | undefined>;
  /**
   * Follow ruleset changes (`nft monitor`): `onChange` for every burst of
   * events, `onExit` once if the monitor ends by itself.
   */
  monitor?(onChange: () => void, onExit: () => void): Promise<NftMonitor>;
}

export class SystemNftRunner implements NftRunner {
  private binary: string | undefined;

  async apply(ruleset: string): Promise<void> {
    const binary = await this.resolve();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ['-f', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), NFT_TIMEOUT_MS);
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`nft exited with ${code}: ${stderr.trim()}`));
      });
      child.stdin.end(ruleset);
    });
  }

  async listTable(): Promise<string | undefined> {
    const binary = await this.resolve();
    try {
      const result = await execFile(binary, ['list', 'table', 'bridge', AGENT_IPV6_GUARD_TABLE], {
        timeout: NFT_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
      });
      return result.stdout;
    } catch {
      return undefined;
    }
  }

  async monitor(onChange: () => void, onExit: () => void): Promise<NftMonitor> {
    const binary = await this.resolve();
    const child = spawn(binary, ['monitor'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let ended = false;
    const exited = (): void => {
      if (ended) return;
      ended = true;
      onExit();
    };
    child.stdout.on('data', () => onChange());
    child.on('error', exited);
    child.on('close', exited);
    return {
      stop: () => {
        ended = true;
        child.kill('SIGTERM');
      },
    };
  }

  private async resolve(): Promise<string> {
    if (this.binary) return this.binary;
    for (const candidate of NFT_BINARIES) {
      try {
        await execFile(candidate, ['--version'], { timeout: NFT_TIMEOUT_MS });
        this.binary = candidate;
        return candidate;
      } catch {
        // try the next location
      }
    }
    throw new Error('nft is not installed');
  }
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

/** Coalesce a burst of ruleset events (a firewall reload is many) into one check. */
const MONITOR_DEBOUNCE_MS = 200;
/**
 * Ceiling of the back-off between monitor-driven checks while they keep
 * failing. A failed check re-applies the table, which is itself a ruleset
 * change the monitor reports: without the back-off a table that applies but
 * never verifies would be re-applied every 200 ms forever.
 */
const MONITOR_MAX_BACKOFF_MS = 60_000;
const MONITOR_RESTART_MS = 5_000;

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
  private readonly listeners = new Set<(status: AgentHostStatus) => void>();

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
   * Re-check after every ruleset change until the returned function is called.
   * Changes reported while a monitor-driven check runs (its own apply among
   * them) lead to one more check after it; while those checks keep failing,
   * each waits twice as long as the last, up to MONITOR_MAX_BACKOFF_MS. Any
   * check that verifies the table (the timer's, a NIC's) ends the back-off,
   * and a backed-off check still waiting is rescheduled at the normal delay.
   */
  watch(): () => void {
    const monitor = this.nft.monitor?.bind(this.nft);
    if (!monitor) return () => undefined;
    let stopped = false;
    let active: NftMonitor | undefined;
    let debounce: NodeJS.Timeout | undefined;
    let restart: NodeJS.Timeout | undefined;
    let checking = false;
    let changedDuringCheck = false;
    let failures = 0;
    const changed = (): void => {
      if (stopped || debounce) return;
      if (checking) {
        changedDuringCheck = true;
        return;
      }
      const delay = Math.min(MONITOR_DEBOUNCE_MS * 2 ** failures, MONITOR_MAX_BACKOFF_MS);
      debounce = setTimeout(() => {
        debounce = undefined;
        checking = true;
        void this.ensure().then((present) => {
          checking = false;
          failures = present ? 0 : Math.min(failures + 1, 16);
          if (changedDuringCheck) {
            changedDuringCheck = false;
            changed();
          }
        });
      }, delay);
    };
    const start = (): void => {
      monitor(changed, () => {
        active = undefined;
        if (stopped) return;
        // Whatever happened while nobody watched is checked now.
        changed();
        restart = setTimeout(start, MONITOR_RESTART_MS);
      }).then((started) => {
        if (stopped) started.stop();
        else active = started;
      }, () => {
        if (!stopped) restart = setTimeout(start, MONITOR_RESTART_MS);
      });
    };
    const stopListening = this.onChange(({ ipv6Guard }) => {
      // Failures only ever leave the guard absent, so verifying again is always this transition.
      if (!ipv6Guard.present || failures === 0) return;
      failures = 0;
      if (debounce) {
        clearTimeout(debounce);
        debounce = undefined;
        changed();
      }
    });
    start();
    return () => {
      stopped = true;
      stopListening();
      if (debounce) clearTimeout(debounce);
      if (restart) clearTimeout(restart);
      active?.stop();
    };
  }

  /** Called with the new status whenever presence or the error changes. */
  onChange(listener: (status: AgentHostStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get error(): string | null {
    return this.lastError;
  }

  status(): AgentHostStatus {
    return { ipv6Guard: { present: this.present, error: this.lastError } };
  }

  samples(): NodeMetricSample[] {
    return [{ name: 'nyabase_node_ipv6_guard_present', labels: {}, value: this.present ? 1 : 0 }];
  }

  private async check(): Promise<boolean> {
    let present = false;
    let error: string | null = null;
    try {
      const listing = await this.nft.listTable();
      if (!listing || !guardTableIsComplete(listing)) {
        await this.nft.apply(renderIpv6GuardRuleset());
      }
      const verified = await this.nft.listTable();
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
