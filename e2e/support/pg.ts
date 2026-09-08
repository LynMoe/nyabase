import { runCommand } from './incus-control.js';
import { requireRuntimeEnv } from './runtime-env.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function setVolumeUsedBytes(volumeId: string, usedBytes: number): Promise<void> {
  if (!UUID.test(volumeId)) {
    throw new Error(`setVolumeUsedBytes rejected volume id ${volumeId}`);
  }
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) {
    throw new Error(`setVolumeUsedBytes rejected usedBytes ${usedBytes}`);
  }
  const result = await runCommand('psql', [
    requireRuntimeEnv('E2E_DATABASE_URL'),
    '-v',
    'ON_ERROR_STOP=1',
    '-tAc',
    `update control.volumes set used_bytes = ${usedBytes} where id = '${volumeId}' returning used_bytes;`,
  ]);
  if (result.code !== 0) {
    throw new Error(`setVolumeUsedBytes failed: ${result.stderr || result.stdout}`);
  }
  const written = Number(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^\d+$/.test(line)),
  );
  if (written !== usedBytes) {
    throw new Error(`setVolumeUsedBytes wrote ${result.stdout.trim()} wanted ${usedBytes}`);
  }
}
