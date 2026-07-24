import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const orchestratorDir = dirname(fileURLToPath(import.meta.url));
const commonPath = join(orchestratorDir, 'common.sh');

function captureSnapshot(path) {
  execFileSync(
    'bash',
    ['-c', 'source "$1"; snapshot_host_nfsd "$2"', 'bash', commonPath, path],
    { stdio: 'pipe' },
  );
  return readFileSync(path, 'utf8');
}

test('host nfsd snapshot is semantic and ignores a container-style ganesha process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nyabase-host-nfsd-'));
  const beforePath = join(root, 'before');
  const duringPath = join(root, 'during');
  const ganeshaPath = join(root, 'ganesha.nfsd');
  let child;
  try {
    const before = captureSnapshot(beforePath);
    copyFileSync('/bin/sleep', ganeshaPath);
    chmodSync(ganeshaPath, 0o700);
    child = spawn(ganeshaPath, ['30'], { stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      setTimeout(resolve, 50);
    });

    const matchingProcesses = execFileSync('pgrep', ['-a', 'nfsd'], { encoding: 'utf8' });
    assert.match(matchingProcesses, new RegExp(`^${child.pid} `, 'm'));
    const during = captureSnapshot(duringPath);

    assert.equal(during, before);
    assert.match(before, /^\[services\]$/m);
    assert.match(before, /^<nfs-server\.service>$/m);
    assert.match(before, /^<nfsdcld\.service>$/m);
    assert.match(before, /^\[listener\]$/m);
    assert.doesNotMatch(before, /^\[processes\]$/m);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
