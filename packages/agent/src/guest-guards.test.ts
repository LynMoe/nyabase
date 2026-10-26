import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_FIREWALL_TABLE, formatAgentSecret } from '@nyabase/common';
import { CredentialStore } from './credential-store.js';
import { FirewallStore } from './firewall-store.js';
import { FakeNft, firewallDocument, OTHER_SERVER_HEX, SERVER_HEX, SERVER_ID } from './firewall.test-helper.js';
import { startGuestGuards, storedServerId } from './guest-guards.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nyabase-agent-guards-'));
  directories.push(directory);
  return directory;
}

describe('guest guards from local state', () => {
  it('restores the persisted document of the server the credential names', async () => {
    const dir = await stateDir();
    await new CredentialStore(dir).write(formatAgentSecret('credential', SERVER_ID, 'A'.repeat(43)));
    await new FirewallStore(dir).write(SERVER_HEX, firewallDocument('a'));
    expect(await storedServerId(dir)).toBe(SERVER_ID);
    const nft = new FakeNft();
    const guards = await startGuestGuards({ stateDir: dir, serverId: await storedServerId(dir), nft, log: () => undefined });
    expect(guards.guardInPlace).toBe(true);
    expect(guards.firewallRestored).toBe('document');
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain(`server=${SERVER_HEX} digest=${'a'.repeat(64)}`);
  });

  it('fails closed without a credential, or with a document of another server', async () => {
    const dir = await stateDir();
    expect(await storedServerId(dir)).toBeUndefined();
    await new FirewallStore(dir).write(OTHER_SERVER_HEX, firewallDocument('a'));
    const nft = new FakeNft();
    const guards = await startGuestGuards({ stateDir: dir, nft, log: () => undefined });
    expect(guards.firewallRestored).toBe('fail-closed');
    expect(nft.tables.get(AGENT_FIREWALL_TABLE)).toContain('server=unknown digest=fail-closed');
  });

  it('reports a table nft cannot write', async () => {
    const nft = new FakeNft();
    nft.failApply = () => new Error('Operation not permitted');
    const guards = await startGuestGuards({ stateDir: await stateDir(), nft, log: () => undefined });
    expect(guards).toMatchObject({ guardInPlace: false, firewallRestored: 'none' });
  });
});
