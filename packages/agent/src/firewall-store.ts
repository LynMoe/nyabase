import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { zFirewallDocument, type FirewallDocument } from '@nyabase/common';
import type { FirewallOwner } from './firewall-render.js';

export const FIREWALL_STATE_FILE = 'firewall.json';

interface StoredFirewall {
  readonly version: 1;
  /** The server the Backend sent the document to (firewall-render.ts owner form). */
  readonly serverId: FirewallOwner;
  readonly document: FirewallDocument;
}

function parseStored(value: unknown): StoredFirewall | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'document,serverId,version') return null;
  if (record.version !== 1 || typeof record.serverId !== 'string' || !/^[0-9a-f]{32}$/.test(record.serverId)) return null;
  const document = zFirewallDocument.safeParse(record.document);
  return document.success ? { version: 1, serverId: record.serverId, document: document.data } : null;
}

export type StoredFirewallRead =
  | { readonly kind: 'document'; readonly serverId: FirewallOwner; readonly document: FirewallDocument }
  | { readonly kind: 'none'; readonly reason: string };

/**
 * The last firewall document the Backend sent, kept across restarts in
 * `<stateDir>/firewall.json` (0600) so the table is back before Incus
 * restores containers at boot. Anything unreadable reads as no document, which
 * keeps guest egress closed rather than guessing.
 */
export class FirewallStore {
  constructor(private readonly stateDir: string) {}

  get path(): string {
    return join(this.stateDir, FIREWALL_STATE_FILE);
  }

  async read(): Promise<StoredFirewallRead> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { kind: 'none', reason: code === 'ENOENT' ? `${this.path} does not exist` : `cannot read ${this.path}: ${code ?? String(error)}` };
    }
    let parsed: StoredFirewall | null = null;
    try {
      parsed = parseStored(JSON.parse(text));
    } catch {
      // not JSON: same as any other unusable content
    }
    if (!parsed) return { kind: 'none', reason: `${this.path} is not a valid firewall document` };
    return { kind: 'document', serverId: parsed.serverId, document: parsed.document };
  }

  /** Atomic and durable: a crash leaves the old file or the new one, never a torn one. */
  async write(serverId: FirewallOwner, document: FirewallDocument): Promise<void> {
    const value = parseStored({ version: 1, serverId, document });
    if (!value) throw new Error('refusing to store an invalid firewall document');
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    const file = await open(temporary, 'w', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.path);
    const directory = await open(this.stateDir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
