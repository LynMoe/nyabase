import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIREWALL_STATE_FILE, FirewallStore } from './firewall-store.js';
import { firewallDocument, SERVER_HEX } from './firewall.test-helper.js';

const directories: string[] = [];

async function stateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nyabase-agent-firewall-'));
  directories.push(directory);
  return join(directory, 'state');
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const DOCUMENT = firewallDocument('a', [{ action: 'drop', protocol: 'tcp', cidrs: ['10.0.0.0/8'], ports: [{ from: 22, to: 22 }] }]);

describe('firewall document store', () => {
  it('writes the document 0600 with its server id, leaving no temporary file', async () => {
    const dir = await stateDir();
    const store = new FirewallStore(dir);
    await store.write(SERVER_HEX, DOCUMENT);
    await store.write(SERVER_HEX, { ...DOCUMENT, digest: 'b'.repeat(64) });
    expect(await readdir(dir)).toEqual([FIREWALL_STATE_FILE]);
    expect((await stat(join(dir, FIREWALL_STATE_FILE))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, FIREWALL_STATE_FILE), 'utf8'))).toEqual({
      version: 1,
      serverId: SERVER_HEX,
      document: { ...DOCUMENT, digest: 'b'.repeat(64) },
    });
    await expect(store.read()).resolves.toEqual({ kind: 'document', serverId: SERVER_HEX, document: { ...DOCUMENT, digest: 'b'.repeat(64) } });
  });

  it('reads a missing, torn or foreign-shaped file as no document', async () => {
    const dir = await stateDir();
    const store = new FirewallStore(dir);
    await expect(store.read()).resolves.toMatchObject({ kind: 'none', reason: expect.stringContaining('does not exist') });
    await store.write(SERVER_HEX, DOCUMENT);
    const text = await readFile(store.path, 'utf8');
    for (const content of [
      text.slice(0, text.length / 2),
      '',
      JSON.stringify({ version: 2, serverId: SERVER_HEX, document: DOCUMENT }),
      JSON.stringify({ version: 1, serverId: 'unknown', document: DOCUMENT }),
      JSON.stringify({ version: 1, serverId: SERVER_HEX, document: { ...DOCUMENT, digest: 'nope' } }),
      JSON.stringify({ version: 1, serverId: SERVER_HEX, document: DOCUMENT, extra: 1 }),
      JSON.stringify([DOCUMENT]),
    ]) {
      await writeFile(store.path, content);
      await expect(store.read(), content).resolves.toMatchObject({ kind: 'none', reason: expect.stringContaining('not a valid') });
    }
  });

  it('refuses to store what it could not read back', async () => {
    const store = new FirewallStore(await stateDir());
    await expect(store.write('unknown', DOCUMENT)).rejects.toThrow('invalid');
  });
});
