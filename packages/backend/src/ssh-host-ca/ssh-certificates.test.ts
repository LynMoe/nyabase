import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  generateEd25519Authority,
  parseEd25519PublicKey,
  signEd25519HostCertificate,
} from './ssh-certificates.js';

const dir = mkdtempSync(join(tmpdir(), 'nyabase-cert-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function hostKey(name: string): string {
  const path = join(dir, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'host', '-f', path]);
  return readFileSync(`${path}.pub`, 'utf8').trim();
}

describe('OpenSSH Ed25519 host certificates', () => {
  it('produces a certificate ssh-keygen reads as a forever host certificate from the authority', () => {
    const authority = generateEd25519Authority('nyabase-host-ca alice');
    const host = hostKey('host-a');
    const certificate = signEd25519HostCertificate({
      authorityPrivateKeyPem: authority.privateKeyPem,
      hostPublicKey: host,
      principals: ['work.nya', 'work'],
      keyId: 'nyabase:container-a',
    });
    const certPath = join(dir, 'host-a-cert.pub');
    writeFileSync(certPath, `${certificate}\n`);
    const listing = execFileSync('ssh-keygen', ['-L', '-f', certPath], { encoding: 'utf8' });
    expect(listing).toContain('Type: ssh-ed25519-cert-v01@openssh.com host certificate');
    expect(listing).toContain('Key ID: "nyabase:container-a"');
    expect(listing).toContain('Valid: forever');
    expect(listing).toMatch(/Principals:\s*\n\s+work\.nya\n\s+work\n/);

    const caPath = join(dir, 'ca.pub');
    writeFileSync(caPath, `${authority.publicKey}\n`);
    const caFingerprint = execFileSync('ssh-keygen', ['-l', '-f', caPath], { encoding: 'utf8' }).split(/\s+/)[1];
    expect(listing).toContain(`Signing CA: ED25519 ${caFingerprint}`);
    const hostFingerprint = execFileSync('ssh-keygen', ['-l', '-f', join(dir, 'host-a.pub')], { encoding: 'utf8' })
      .split(/\s+/)[1];
    expect(listing).toContain(`Public key: ED25519-CERT ${hostFingerprint}`);
  });

  it('is deterministic for the same inputs and changes with the principals', () => {
    const authority = generateEd25519Authority('ca');
    const host = hostKey('host-b');
    const sign = (principals: string[]) => signEd25519HostCertificate({
      authorityPrivateKeyPem: authority.privateKeyPem,
      hostPublicKey: host,
      principals,
      keyId: 'nyabase:b',
    });
    expect(sign(['b.nya'])).toBe(sign(['b.nya']));
    expect(sign(['b.nya'])).not.toBe(sign(['b.lab']));
  });

  it('accepts only Ed25519 host keys', () => {
    expect(parseEd25519PublicKey(hostKey('host-c'))).toHaveLength(32);
    expect(parseEd25519PublicKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ host')).toBeNull();
    expect(parseEd25519PublicKey('ssh-ed25519 AAAA')).toBeNull();
    expect(() => signEd25519HostCertificate({
      authorityPrivateKeyPem: generateEd25519Authority('ca').privateKeyPem,
      hostPublicKey: 'ssh-rsa AAAA host',
      principals: ['x'],
      keyId: 'x',
    })).toThrow(/Ed25519/);
  });
});
