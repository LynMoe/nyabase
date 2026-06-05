import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const EXTRACT_PATH = '/var/lib/nyabase-agent/nyabase-mount-helper';

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * When running as a pkg binary, extract the embedded mount-helper to the real
 * filesystem so it can be executed via execFile.  In dev/ts-node mode the
 * configured path is returned unchanged.
 */
export function resolveAndExtractMountHelper(configuredPath: string): string {
  if (!('pkg' in process)) {
    return configuredPath;
  }

  // pkg embeds the asset next to the bundle entry in the snapshot filesystem.
  const assetPath = path.join(__dirname, 'nyabase-mount-helper');
  try {
    const data = fs.readFileSync(assetPath);
    fs.mkdirSync(path.dirname(EXTRACT_PATH), { recursive: true });
    // Skip the write (and the slow fsync that comes with it) when the extracted
    // copy is already byte-identical to what's embedded. Runs once at boot, so
    // synchronous hashing is fine here.
    const incoming = sha256(data);
    let existing: string | null = null;
    try {
      if (fs.existsSync(EXTRACT_PATH)) {
        existing = sha256(fs.readFileSync(EXTRACT_PATH));
      }
    } catch { /* fall through to write */ }
    if (existing === incoming) {
      console.log('[Agent] mount-helper already up to date at', EXTRACT_PATH);
    } else {
      fs.writeFileSync(EXTRACT_PATH, data, { mode: 0o755 });
      console.log('[Agent] Extracted embedded mount-helper to', EXTRACT_PATH);
    }
    return EXTRACT_PATH;
  } catch (e) {
    console.warn('[Agent] Failed to extract embedded mount-helper:', e);
    return configuredPath;
  }
}
