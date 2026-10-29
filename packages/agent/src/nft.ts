import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const NFT_TIMEOUT_MS = 5_000;
const NFT_BINARIES = ['/usr/sbin/nft', '/sbin/nft', 'nft'] as const;
/** A firewall table with 4096 address ranges lists well under this. */
const NFT_LIST_MAX_BYTES = 4 * 1024 * 1024;

export interface NftMonitor {
  stop(): void;
}

/** nft ran and refused the input (as opposed to not running at all). */
export class NftRefusedError extends Error {}

export interface NftRunner {
  /** `nft -f -`: one transaction, applied entirely or not at all. */
  apply(ruleset: string): Promise<void>;
  /** `nft -c -f -`: would `apply` accept this? Changes nothing. */
  check(ruleset: string): Promise<void>;
  /** `nft -t list table bridge <table>` (set elements omitted), undefined when it does not exist (or nft fails). */
  listTable(table: string): Promise<string | undefined>;
  /**
   * Follow ruleset changes (`nft monitor`): `onChange` for every burst of
   * events, `onExit` once if the monitor ends by itself.
   */
  monitor?(onChange: () => void, onExit: () => void): Promise<NftMonitor>;
}

export class SystemNftRunner implements NftRunner {
  private binary: string | undefined;

  apply(ruleset: string): Promise<void> {
    return this.feed(['-f', '-'], ruleset);
  }

  check(ruleset: string): Promise<void> {
    return this.feed(['-c', '-f', '-'], ruleset);
  }

  async listTable(table: string): Promise<string | undefined> {
    const binary = await this.resolve();
    try {
      // Terse: without set elements, which the firewall's dynamic sets change with traffic.
      const result = await execFile(binary, ['-t', 'list', 'table', 'bridge', table], {
        timeout: NFT_TIMEOUT_MS,
        maxBuffer: NFT_LIST_MAX_BYTES,
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

  private async feed(args: readonly string[], ruleset: string): Promise<void> {
    const binary = await this.resolve();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, NFT_TIMEOUT_MS);
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else if (timedOut) reject(new Error('nft did not finish in time'));
        else reject(new NftRefusedError(`nft exited with ${code}: ${stderr.trim()}`));
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(ruleset);
    });
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

/** Ruleset change notifications, shared by everything that keeps an nft table. */
export interface RulesetChangeFeed {
  /** `onChange` after every burst of changes, and once when the feed restarts after a gap. */
  subscribe(onChange: () => void): () => void;
}

const MONITOR_RESTART_MS = 5_000;

/**
 * One `nft monitor` process for every subscriber (the IPv6 guard and the
 * firewall). It runs while anyone subscribes and is restarted when it ends;
 * a restart notifies everyone, since nobody watched in between.
 */
export class NftMonitorHub implements RulesetChangeFeed {
  private readonly subscribers = new Set<() => void>();
  private active: NftMonitor | undefined;
  private restart: NodeJS.Timeout | undefined;
  private generation = 0;

  constructor(private readonly nft: NftRunner) {}

  subscribe(onChange: () => void): () => void {
    // Wrapped, so subscribing the same function twice still counts twice.
    const subscriber = (): void => onChange();
    this.subscribers.add(subscriber);
    if (this.subscribers.size === 1) this.start();
    return () => {
      if (!this.subscribers.delete(subscriber) || this.subscribers.size > 0) return;
      this.generation += 1;
      if (this.restart) clearTimeout(this.restart);
      this.restart = undefined;
      this.active?.stop();
      this.active = undefined;
    };
  }

  private notify(): void {
    for (const subscriber of [...this.subscribers]) subscriber();
  }

  private start(): void {
    const monitor = this.nft.monitor?.bind(this.nft);
    if (!monitor) return;
    const generation = ++this.generation;
    const current = (): boolean => generation === this.generation;
    const retry = (): void => {
      this.restart = setTimeout(() => {
        this.restart = undefined;
        if (current()) this.start();
      }, MONITOR_RESTART_MS);
    };
    monitor(() => {
      if (current()) this.notify();
    }, () => {
      if (!current()) return;
      this.active = undefined;
      // Whatever happened while nobody watched is checked now.
      this.notify();
      retry();
    }).then((started) => {
      if (current()) this.active = started;
      else started.stop();
    }, () => {
      if (current()) retry();
    });
  }
}

/** Coalesce a burst of ruleset events (a firewall reload is many) into one check. */
const MONITOR_DEBOUNCE_MS = 200;
/**
 * Ceiling of the back-off between change-driven checks while they keep
 * failing. A failed check re-applies the table, which is itself a ruleset
 * change the monitor reports: without the back-off a table that applies but
 * never verifies would be re-applied every 200 ms forever.
 */
const MONITOR_MAX_BACKOFF_MS = 60_000;

/**
 * Run `check` after every ruleset change `feed` reports, until the returned
 * function is called. Changes reported while a change-driven check runs (its
 * own apply among them) lead to one more check after it; while those checks
 * keep failing, each waits twice as long as the last, up to
 * MONITOR_MAX_BACKOFF_MS. `onVerified` tells when any check (the timer's, a
 * NIC's) verified the table: that ends the back-off, and a backed-off check
 * still waiting is rescheduled at the normal delay. Every caller has its own
 * debounce and back-off, so one table failing does not slow the other.
 */
export function recheckOnChanges(
  feed: RulesetChangeFeed,
  check: () => Promise<boolean>,
  onVerified: (listener: () => void) => () => void,
): () => void {
  let stopped = false;
  let debounce: NodeJS.Timeout | undefined;
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
      void check().then((present) => {
        checking = false;
        failures = present ? 0 : Math.min(failures + 1, 16);
        if (changedDuringCheck) {
          changedDuringCheck = false;
          changed();
        }
      });
    }, delay);
  };
  const stopListening = onVerified(() => {
    if (failures === 0) return;
    failures = 0;
    if (debounce) {
      clearTimeout(debounce);
      debounce = undefined;
      changed();
    }
  });
  const unsubscribe = feed.subscribe(changed);
  return () => {
    stopped = true;
    stopListening();
    unsubscribe();
    if (debounce) clearTimeout(debounce);
  };
}
