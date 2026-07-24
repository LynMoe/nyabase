import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function read(name) {
  return readFileSync(required(name), 'utf8').trimEnd();
}

const output = required('SNAPSHOT_DIR');
const externalPublicKey = read('EXTERNAL_PUBLIC_KEY_FILE');
const internalPrivateKey = `${read('INTERNAL_PRIVATE_KEY_FILE')}\n`;
const internalPublicKey = read('INTERNAL_PUBLIC_KEY_FILE');
const proxyHostPrivateKey = `${read('PROXY_HOST_PRIVATE_KEY_FILE')}\n`;
const proxyHostPublicKey = read('PROXY_HOST_PUBLIC_KEY_FILE');
const internalFingerprint = required('INTERNAL_KEY_FINGERPRINT');
const proxyHostFingerprint = required('PROXY_HOST_KEY_FINGERPRINT');
const targetHostFingerprint = required('TARGET_HOST_KEY_FINGERPRINT');
const sshTargetIp = required('SSH_TARGET_IP');
const httpTargetIp = required('HTTP_TARGET_IP');

function sshSnapshot(generation, revoked) {
  return {
    generation,
    staleAfterMs: 300_000,
    validUntil: Date.now() + 300_000,
    hostKey: {
      privateKey: proxyHostPrivateKey,
      publicKey: proxyHostPublicKey,
      fingerprint: proxyHostFingerprint,
      generation: 1,
    },
    users: [{
      id: 'user-poc',
      username: 'alice',
      status: 'active',
      publicKeys: [externalPublicKey],
      internalPrivateKey,
      internalPublicKey,
      internalKeyFingerprint: internalFingerprint,
      internalKeyGeneration: 1,
    }],
    servers: [{ id: 'server-poc', slug: 'cpu-a', name: 'CPU A', online: true }],
    images: [{ id: 'image-poc', disableSsh: false }],
    containers: revoked ? [] : [{
      id: 'container-poc',
      ownerId: 'user-poc',
      serverId: 'server-poc',
      imageId: 'image-poc',
      name: 'work',
    }],
    routes: revoked ? [] : [{
      containerId: 'container-poc',
      serverId: 'server-poc',
      runtimeId: 'runtime-poc',
      macvlanIp: sshTargetIp,
      runtimeStatus: 'running',
      sshStatus: 'running',
      appliedInternalKeyGeneration: 1,
      containerHostKeyFingerprint: targetHostFingerprint,
      observedAt: new Date().toISOString(),
    }],
  };
}

function httpSnapshot(generation, revoked) {
  return {
    generation,
    staleAfterMs: 300_000,
    validUntil: Date.now() + 300_000,
    routes: revoked ? [] : [{
      bindingId: 'binding-poc',
      hostname: 'app.poc.test',
      domainPoolId: 'pool-poc',
      ownerId: 'user-poc',
      containerId: 'container-poc',
      runtimeId: 'runtime-poc',
      targetIp: httpTargetIp,
      targetPort: 8080,
    }],
    domainPools: [],
  };
}

writeFileSync(join(output, 'ssh-initial.json'), `${JSON.stringify(sshSnapshot(1, false))}\n`, { mode: 0o600 });
writeFileSync(join(output, 'ssh-revoked.json'), `${JSON.stringify(sshSnapshot(2, true))}\n`, { mode: 0o600 });
writeFileSync(join(output, 'http-initial.json'), `${JSON.stringify(httpSnapshot(1, false))}\n`, { mode: 0o600 });
writeFileSync(join(output, 'http-revoked.json'), `${JSON.stringify(httpSnapshot(2, true))}\n`, { mode: 0o600 });
writeFileSync(join(output, 'metadata.json'), `${JSON.stringify({
  proxyHostFingerprint,
  internalFingerprint,
  targetHostFingerprint,
  sshTargetIp,
  httpTargetIp,
}, null, 2)}\n`, { mode: 0o600 });
