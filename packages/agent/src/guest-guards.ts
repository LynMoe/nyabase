import { parseAgentSecret } from '@nyabase/common';
import { CredentialStore } from './credential-store.js';
import { GuestFirewall, type FirewallRestoreResult } from './firewall.js';
import { FirewallStore } from './firewall-store.js';
import { Ipv6Guard } from './ipv6-guard.js';
import { SystemNftRunner, type NftRunner } from './nft.js';

/** The server id the stored credential names, or undefined (none yet, or unreadable). */
export async function storedServerId(stateDir: string): Promise<string | undefined> {
  try {
    const credential = await new CredentialStore(stateDir).read();
    return credential ? parseAgentSecret('credential', credential)?.serverId : undefined;
  } catch {
    return undefined;
  }
}

export interface GuestGuards {
  readonly guard: Ipv6Guard;
  readonly firewall: GuestFirewall;
  readonly guardInPlace: boolean;
  readonly firewallRestored: FirewallRestoreResult;
}

/**
 * Put both guest tables in place from local state alone: the IPv6 guard, and
 * the firewall from the persisted document (fail-closed without one). Used by
 * the agent at start and by `guest-guards` before Incus starts; neither needs
 * the Backend.
 */
export async function startGuestGuards(options: {
  readonly stateDir: string;
  readonly serverId?: string;
  readonly nft?: NftRunner;
  readonly log: (message: string) => void;
}): Promise<GuestGuards> {
  const nft = options.nft ?? new SystemNftRunner();
  const guard = new Ipv6Guard(nft);
  const firewall = new GuestFirewall({
    store: new FirewallStore(options.stateDir),
    nft,
    serverId: options.serverId,
    log: options.log,
  });
  const [guardInPlace, firewallRestored] = await Promise.all([guard.ensure(), firewall.restore()]);
  return { guard, firewall, guardInPlace, firewallRestored };
}
