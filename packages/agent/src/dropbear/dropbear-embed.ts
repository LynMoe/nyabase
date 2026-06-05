import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ASSET_NAME = 'nyabase-dropbear-linux-x64';
const PKG_ASSET_NAME = 'nyabase-dropbear';
const EXTRACT_PATH = '/var/lib/nyabase-agent/nyabase-dropbear';

export interface DropbearAsset {
  binaryPath: string;
  sha256Path?: string;
  source: 'env' | 'pkg' | 'source' | 'missing';
  missingReason?: string;
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function maybeShaPath(binaryPath: string): string | undefined {
  const candidates = [`${binaryPath}.sha256`];
  return candidates.find((p) => fs.existsSync(p));
}

function sourceAssetPath(): string {
  return path.resolve(__dirname, '../../assets/dropbear', ASSET_NAME);
}

export function resolveAndExtractDropbear(): DropbearAsset {
  const override = process.env.NYABASE_DROPBEAR_PATH;
  if (override) {
    return {
      binaryPath: override,
      sha256Path: maybeShaPath(override),
      source: 'env',
    };
  }

  if ('pkg' in process) {
    const assetPath = path.join(__dirname, PKG_ASSET_NAME);
    const shaAssetPath = path.join(__dirname, `${PKG_ASSET_NAME}.sha256`);
    try {
      const data = fs.readFileSync(assetPath);
      fs.mkdirSync(path.dirname(EXTRACT_PATH), { recursive: true });
      const incoming = sha256(data);
      let existing: string | null = null;
      try {
        if (fs.existsSync(EXTRACT_PATH)) existing = sha256(fs.readFileSync(EXTRACT_PATH));
      } catch { /* fall through to write */ }
      if (existing !== incoming) {
        fs.writeFileSync(EXTRACT_PATH, data, { mode: 0o755 });
        console.log('[Agent] Extracted embedded Dropbear to', EXTRACT_PATH);
      }
      const extractedShaPath = `${EXTRACT_PATH}.sha256`;
      if (fs.existsSync(shaAssetPath)) {
        fs.writeFileSync(extractedShaPath, fs.readFileSync(shaAssetPath));
      }
      return {
        binaryPath: EXTRACT_PATH,
        sha256Path: fs.existsSync(extractedShaPath) ? extractedShaPath : undefined,
        source: 'pkg',
      };
    } catch (e) {
      console.warn('[Agent] Failed to extract embedded Dropbear:', e);
      return {
        binaryPath: assetPath,
        sha256Path: fs.existsSync(shaAssetPath) ? shaAssetPath : undefined,
        source: 'pkg',
      };
    }
  }

  const binaryPath = sourceAssetPath();
  if (!fs.existsSync(binaryPath)) {
    return {
      binaryPath: '',
      source: 'missing',
      missingReason: [
        'Dropbear binary is not configured for source-mode agent runtime.',
        `Set NYABASE_DROPBEAR_PATH to a trusted static Dropbear binary, or provide ${binaryPath}.`,
        'Packaged agent binaries must embed nyabase-dropbear via scripts/build-agent-binary.sh.',
      ].join(' '),
    };
  }

  return {
    binaryPath,
    sha256Path: maybeShaPath(binaryPath),
    source: 'source',
  };
}
