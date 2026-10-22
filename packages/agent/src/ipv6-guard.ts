import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AGENT_IPV6_GUARD_TABLE,
  MANAGED_NIC_HOST_NAME_PREFIX,
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

export interface NftRunner {
  apply(ruleset: string): Promise<void>;
  listTable(): Promise<string | undefined>;
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

export class Ipv6Guard {
  private present = false;
  private lastError: string | undefined;

  constructor(private readonly nft: NftRunner = new SystemNftRunner()) {}

  /** Re-assert the table; cheap and idempotent, called at start and on a timer. */
  async ensure(): Promise<boolean> {
    try {
      const listing = await this.nft.listTable();
      if (!listing || !guardTableIsComplete(listing)) {
        await this.nft.apply(renderIpv6GuardRuleset());
      }
      const verified = await this.nft.listTable();
      this.present = Boolean(verified && guardTableIsComplete(verified));
      this.lastError = this.present ? undefined : 'guard table did not verify after apply';
    } catch (error) {
      this.present = false;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return this.present;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  samples(): NodeMetricSample[] {
    return [{ name: 'nyabase_node_ipv6_guard_present', labels: {}, value: this.present ? 1 : 0 }];
  }
}
