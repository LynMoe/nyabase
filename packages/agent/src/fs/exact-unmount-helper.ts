/**
 * Runs under the global physical flock. The helper samples mountinfo and calls
 * umount in the same fenced process, closing the last parent/child TOCTOU gap.
 */
function exactUnmountHelperMain(): void {
  const fs = require('fs') as typeof import('fs');
  const childProcess = require('child_process') as typeof import('child_process');
  const expected = JSON.parse(process.argv[1] || '{}') as Record<string, unknown>;
  const mountInfoPath = process.argv[2] || '/proc/self/mountinfo';
  const umountExecutable = process.argv[3] || 'umount';
  const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_match: string, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
  const entries = fs.readFileSync(mountInfoPath, 'utf8').split('\n').flatMap((line: string) => {
    if (!line.trim()) return [];
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || separator + 3 >= fields.length) return [];
    return [{
      mountId: Number(fields[0]),
      parentMountId: Number(fields[1]),
      deviceId: fields[2],
      fsRoot: decode(fields[3]),
      mountPoint: decode(fields[4]),
      fsType: decode(fields[separator + 1]),
      src: decode(fields[separator + 2]),
      opts: [...new Set([
        ...fields[5].split(',').filter(Boolean),
        ...fields[separator + 3].split(',').filter(Boolean),
      ])].join(','),
    }];
  });
  const exact = entries.filter((entry) => entry.mountPoint === expected.mountPoint);
  if (exact.length !== 1) {
    throw new Error(`expected exactly one mount at ${String(expected.mountPoint)}, observed ${exact.length}`);
  }
  const observed = exact[0];
  for (const key of [
    'mountId', 'parentMountId', 'deviceId', 'fsRoot', 'mountPoint', 'fsType', 'src', 'opts',
  ]) {
    if (observed[key as keyof typeof observed] !== expected[key]) {
      throw new Error(`mount identity changed at ${String(expected.mountPoint)} (${key})`);
    }
  }
  const result = childProcess.spawnSync(
    umountExecutable,
    ['--', String(expected.mountPoint)],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`umount exited with status ${String(result.status)} signal ${String(result.signal)}`);
  }
}

export const EXACT_UNMOUNT_HELPER_SCRIPT = `(${exactUnmountHelperMain.toString()})();`;
