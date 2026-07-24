import { readFileSync, writeFileSync } from 'node:fs';

const [sshFile, httpFile, output] = process.argv.slice(2);
if (!sshFile || !httpFile || !output) throw new Error('inspect files and output are required');

function verify(name, path) {
  const value = JSON.parse(readFileSync(path, 'utf8'))[0];
  const capDrop = (value.HostConfig?.CapDrop ?? []).map((entry) => entry.toUpperCase());
  const security = value.HostConfig?.SecurityOpt ?? [];
  const mounts = value.Mounts ?? [];
  const environment = value.Config?.Env ?? [];
  const tokenMount = mounts.find((mount) => mount.Destination === '/run/secrets/proxy-token');
  const caMount = mounts.find((mount) => mount.Destination === '/run/ca/backend-ca.crt');
  const failures = [];
  if (value.Config?.User !== '65532:65532') failures.push('unexpected user');
  if (value.HostConfig?.ReadonlyRootfs !== true) failures.push('root filesystem is writable');
  if (!capDrop.includes('ALL')) failures.push('capabilities are not all dropped');
  if (!security.some((entry) => entry.startsWith('no-new-privileges'))) failures.push('no-new-privileges is absent');
  if (!tokenMount || tokenMount.RW !== false) failures.push('token file is not mounted read-only');
  if (!caMount || caMount.RW !== false) failures.push('CA file is not mounted read-only');
  if (mounts.some((mount) => mount.Destination === '/var/run/docker.sock')) failures.push('Docker socket is mounted');
  if (environment.some((entry) => /^(SSH_PROXY_TOKEN|HTTP_PROXY_TOKEN)=/.test(entry))) failures.push('raw token environment variable is present');
  if (!environment.some((entry) => entry === 'NYABASE_BACKEND_CA_FILE=/run/ca/backend-ca.crt')) failures.push('custom CA is absent');
  if (!environment.some((entry) => entry.startsWith('NYABASE_BACKEND_WS=wss://control:8443/'))) failures.push('control URL is not explicit WSS');
  if (failures.length > 0) throw new Error(`${name}: ${failures.join(', ')}`);
  return {
    user: value.Config.User,
    readonlyRootfs: true,
    capDropAll: true,
    noNewPrivileges: true,
    tokenFileReadOnly: true,
    caFileReadOnly: true,
    dockerSocketAbsent: true,
    rawTokenEnvironmentAbsent: true,
    explicitWss: true,
  };
}

writeFileSync(output, `${JSON.stringify({
  ssh: verify('ssh', sshFile),
  http: verify('http', httpFile),
}, null, 2)}\n`);
