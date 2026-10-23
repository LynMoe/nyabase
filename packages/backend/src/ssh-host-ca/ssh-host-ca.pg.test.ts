import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { SshKeyCryptoService } from '../platform/ssh-key-crypto.service.js';
import { SshHostCaService } from './ssh-host-ca.service.js';
import { seedUser } from '../iam/access.pg-test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function cryptoWith(secret: string): SshKeyCryptoService {
  return new SshKeyCryptoService({ keyEncryptionSecret: () => secret } as never);
}

function signingCa(certificate: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nyabase-ca-pg-'));
  try {
    writeFileSync(join(dir, 'cert.pub'), `${certificate}\n`);
    return execFileSync('ssh-keygen', ['-L', '-f', join(dir, 'cert.pub')], { encoding: 'utf8' })
      .match(/Signing CA: (\S+ \S+)/)![1]!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fingerprint(publicKey: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nyabase-ca-pg-'));
  try {
    writeFileSync(join(dir, 'ca.pub'), `${publicKey}\n`);
    const [, value] = execFileSync('ssh-keygen', ['-l', '-f', join(dir, 'ca.pub')], { encoding: 'utf8' }).split(/\s+/);
    return `ED25519 ${value}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function hostKey(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nyabase-ca-pg-'));
  try {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host')]);
    return readFileSync(join(dir, 'host.pub'), 'utf8').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describePg('SshHostCaService', () => {
  it('keeps one stable authority per user and signs only with the owner\'s', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const service = new SshHostCaService(database, cryptoWith('secret-secret-secret-secret-secret'));
      const alice = await seedUser(database, 'alice');
      const bob = await seedUser(database, 'bob');
      const [first, concurrent] = await Promise.all([service.publicKey(alice), service.publicKey(alice)]);
      expect(concurrent).toBe(first);
      expect(await service.publicKey(alice)).toBe(first);
      expect(await service.publicKey(bob)).not.toBe(first);

      const certificate = await service.certify({
        ownerId: alice,
        hostPublicKey: hostKey(),
        principals: ['work.nya', 'work'],
        keyId: 'nyabase:c1',
      });
      expect(signingCa(certificate!)).toBe(fingerprint(first));
    });
  });

  it('refuses to sign with an undecryptable key until the authorities are reset', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const alice = await seedUser(database, 'alice');
      const before = await new SshHostCaService(database, cryptoWith('old-secret-old-secret-old-secret'))
        .publicKey(alice);
      const after = new SshHostCaService(database, cryptoWith('new-secret-new-secret-new-secret'));
      const request = { ownerId: alice, hostPublicKey: hostKey(), principals: ['w.nya'], keyId: 'k' };
      await expect(after.certify(request)).resolves.toBeNull();

      await expect(after.resetAll()).resolves.toBe(1);
      const renewed = await after.publicKey(alice);
      expect(renewed).not.toBe(before);
      expect(signingCa((await after.certify(request))!)).toBe(fingerprint(renewed));
    });
  });
});
