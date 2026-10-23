import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  IncusContainerSshStateAdapter,
  hostCertificatePrincipals,
  reconcileHostCertificate,
} from './container-ssh.js';
import { generateEd25519Authority, signEd25519HostCertificate } from '../ssh-host-ca/ssh-certificates.js';

const HOST_KEY = '/etc/ssh/ssh_host_ed25519_key.pub';
const CERT = '/etc/ssh/ssh_host_ed25519_key-cert.pub';
const DROP_IN_DIR = '/etc/ssh/sshd_config.d';
const DROP_IN = '/etc/ssh/sshd_config.d/50-nyabase-host-certificate.conf';
const STAMP = '/etc/ssh/.nyabase-host-certificate-loaded';

function ed25519Line(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const part = (value: Buffer | string) => {
    const body = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, body]);
  };
  return `ssh-ed25519 ${Buffer.concat([part('ssh-ed25519'), part(raw)]).toString('base64')} root@guest`;
}

function guest(files: Record<string, string>, directories = [DROP_IN_DIR], exitCode = 0) {
  const state = new IncusContainerSshStateAdapter();
  const written = new Map<string, string>();
  vi.spyOn(state, 'readText').mockImplementation(async (_client, _name, path) =>
    written.get(path) ?? files[path] ?? null);
  vi.spyOn(state, 'isDirectory').mockImplementation(async (_client, _name, path) => directories.includes(path));
  const write = vi.spyOn(state, 'writeRootFile').mockImplementation(async (_client, _name, path, content) => {
    written.set(path, content);
  });
  // The script records its stamp argument once sshd reloaded.
  const run = vi.spyOn(state, 'runScript').mockImplementation(async (_client, _name, command) => {
    if (exitCode === 0) written.set(STAMP, `${command[command.length - 1]}\n`);
    return exitCode;
  });
  return { state, written, write, run };
}

const authority = generateEd25519Authority('ca');
const certify = async (hostPublicKey: string) => signEd25519HostCertificate({
  authorityPrivateKeyPem: authority.privateKeyPem,
  hostPublicKey,
  principals: ['work.nya', 'work'],
  keyId: 'nyabase:c',
});
const signal = new AbortController().signal;
const audit = vi.fn(async () => undefined);

describe('container host certificate', () => {
  it('certifies the name with and without the suffix', () => {
    expect(hostCertificatePrincipals('Work', 'nya')).toEqual(['work.nya', 'work']);
  });

  it('issues the certificate and drop-in, reloads sshd, then leaves a converged guest alone', async () => {
    const host = ed25519Line();
    const fake = guest({ [HOST_KEY]: `${host}\n` });
    await expect(reconcileHostCertificate(fake.state, {} as never, 'nyc-x', certify, audit, signal))
      .resolves.toBe('issued');
    expect(fake.written.get(CERT)).toBe(`${await certify(host)}\n`);
    expect(fake.written.get(DROP_IN)).toContain(`HostCertificate ${CERT}`);
    expect(fake.run).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalled();

    fake.write.mockClear();
    fake.run.mockClear();
    await expect(reconcileHostCertificate(fake.state, {} as never, 'nyc-x', certify, audit, signal))
      .resolves.toBe('current');
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('writes nothing without an Ed25519 host key, a CA key, or sshd_config.d', async () => {
    const none = guest({ [HOST_KEY]: 'ssh-rsa AAAAB3Nza root@guest\n' });
    await expect(reconcileHostCertificate(none.state, {} as never, 'nyc-x', certify, audit, signal))
      .resolves.toBe('no_host_key');
    const locked = guest({ [HOST_KEY]: ed25519Line() });
    await expect(reconcileHostCertificate(locked.state, {} as never, 'nyc-x', async () => null, audit, signal))
      .resolves.toBe('unavailable');
    const old = guest({ [HOST_KEY]: ed25519Line() }, []);
    await expect(reconcileHostCertificate(old.state, {} as never, 'nyc-x', certify, audit, signal))
      .resolves.toBe('no_drop_in_directory');
    for (const fake of [none, locked, old]) {
      expect(fake.write).not.toHaveBeenCalled();
      expect(fake.run).not.toHaveBeenCalled();
    }
  });

  it('reports a config sshd refuses and one that never includes the drop-in', async () => {
    const rejected = guest({ [HOST_KEY]: ed25519Line() }, [DROP_IN_DIR], 3);
    await expect(reconcileHostCertificate(rejected.state, {} as never, 'nyc-x', certify, audit, signal))
      .resolves.toBe('config_rejected');
    const excluded = guest({ [HOST_KEY]: ed25519Line() }, [DROP_IN_DIR], 4);
    await expect(reconcileHostCertificate(excluded.state, {} as never, 'nyc-x', certify, audit, signal))
      .resolves.toBe('not_included');
  });

  it('retries a reload that failed even though the files are already in place', async () => {
    const failing = guest({ [HOST_KEY]: ed25519Line() }, [DROP_IN_DIR], 5);
    await expect(reconcileHostCertificate(failing.state, {} as never, 'nyc-x', certify, audit, signal))
      .resolves.toBe('reload_failed');
    await expect(reconcileHostCertificate(failing.state, {} as never, 'nyc-x', certify, audit, signal))
      .resolves.toBe('reload_failed');
    expect(failing.run).toHaveBeenCalledTimes(2);
  });
});
