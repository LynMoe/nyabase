import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const DROPBEAR_ASSET_NAME = 'nyabase-dropbear-linux-x64';
const DROPBEARKEY_ASSET_NAME = 'nyabase-dropbearkey-linux-x64';
const SFTP_ASSET_NAME = 'nyabase-sftp-server-linux-x64';
const PKG_DROPBEAR_NAME = 'nyabase-dropbear';
const PKG_DROPBEARKEY_NAME = 'nyabase-dropbearkey';
const PKG_SFTP_NAME = 'nyabase-sftp-server';
const DROPBEAR_EXTRACT_PATH = '/run/nyabase-agent/nyabase-dropbear';
const DROPBEARKEY_EXTRACT_PATH = '/run/nyabase-agent/nyabase-dropbearkey';
const SFTP_EXTRACT_PATH = '/run/nyabase-agent/nyabase-sftp-server';

export interface DropbearAsset {
  binaryPath: string;
  sha256Path?: string;
  dropbearKeyPath?: string;
  dropbearKeySha256Path?: string;
  sftpServerPath?: string;
  sftpServerSha256Path?: string;
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

function sourceDropbearPath(): string {
  return path.resolve(__dirname, '../../assets/dropbear', DROPBEAR_ASSET_NAME);
}

function sourceSftpServerPath(): string {
  return path.resolve(__dirname, '../../assets/sftp', SFTP_ASSET_NAME);
}

function sourceDropbearKeyPath(): string {
  return path.resolve(__dirname, '../../assets/dropbear', DROPBEARKEY_ASSET_NAME);
}

function extractPkgAsset(assetPath: string, extractPath: string, label: string): { path: string; sha256Path?: string } {
  const shaAssetPath = `${assetPath}.sha256`;
  const data = fs.readFileSync(assetPath);
  fs.mkdirSync(path.dirname(extractPath), { recursive: true });
  const incoming = sha256(data);
  let existing: string | null = null;
  try {
    if (fs.existsSync(extractPath)) existing = sha256(fs.readFileSync(extractPath));
  } catch { /* fall through to write */ }
  if (existing !== incoming) {
    fs.writeFileSync(extractPath, data, { mode: 0o755 });
    console.log(`[Agent] Extracted embedded ${label} to`, extractPath);
  }
  const extractedShaPath = `${extractPath}.sha256`;
  if (fs.existsSync(shaAssetPath)) {
    fs.writeFileSync(extractedShaPath, fs.readFileSync(shaAssetPath));
  }
  return {
    path: extractPath,
    sha256Path: fs.existsSync(extractedShaPath) ? extractedShaPath : undefined,
  };
}

export function resolveAndExtractDropbear(): DropbearAsset {
  const override = process.env.NYABASE_DROPBEAR_PATH;
  if (override) {
    const sourceSftp = sourceSftpServerPath();
    const sourceDropbearKey = sourceDropbearKeyPath();
    const dropbearKeyOverride = process.env.NYABASE_DROPBEARKEY_PATH
      ?? (fs.existsSync(sourceDropbearKey) ? sourceDropbearKey : undefined);
    const sftpOverride = process.env.NYABASE_SFTP_SERVER_PATH
      ?? (fs.existsSync(sourceSftp) ? sourceSftp : undefined);
    return {
      binaryPath: override,
      sha256Path: maybeShaPath(override),
      dropbearKeyPath: dropbearKeyOverride,
      dropbearKeySha256Path: dropbearKeyOverride ? maybeShaPath(dropbearKeyOverride) : undefined,
      sftpServerPath: sftpOverride,
      sftpServerSha256Path: sftpOverride ? maybeShaPath(sftpOverride) : undefined,
      source: 'env',
    };
  }

  if ('pkg' in process) {
    const dropbearAssetPath = path.join(__dirname, PKG_DROPBEAR_NAME);
    const dropbearKeyAssetPath = path.join(__dirname, PKG_DROPBEARKEY_NAME);
    const sftpAssetPath = path.join(__dirname, PKG_SFTP_NAME);
    try {
      const dropbear = extractPkgAsset(dropbearAssetPath, DROPBEAR_EXTRACT_PATH, 'Dropbear');
      const dropbearKey = fs.existsSync(dropbearKeyAssetPath)
        ? extractPkgAsset(dropbearKeyAssetPath, DROPBEARKEY_EXTRACT_PATH, 'Dropbear key utility')
        : undefined;
      const sftp = fs.existsSync(sftpAssetPath)
        ? extractPkgAsset(sftpAssetPath, SFTP_EXTRACT_PATH, 'SFTP server')
        : undefined;
      return {
        binaryPath: dropbear.path,
        sha256Path: dropbear.sha256Path,
        dropbearKeyPath: dropbearKey?.path,
        dropbearKeySha256Path: dropbearKey?.sha256Path,
        sftpServerPath: sftp?.path,
        sftpServerSha256Path: sftp?.sha256Path,
        source: 'pkg',
      };
    } catch (e) {
      console.warn('[Agent] Failed to extract embedded Dropbear:', e);
      return {
        binaryPath: dropbearAssetPath,
        sha256Path: maybeShaPath(dropbearAssetPath),
        dropbearKeyPath: fs.existsSync(dropbearKeyAssetPath) ? dropbearKeyAssetPath : undefined,
        dropbearKeySha256Path: fs.existsSync(dropbearKeyAssetPath) ? maybeShaPath(dropbearKeyAssetPath) : undefined,
        sftpServerPath: fs.existsSync(sftpAssetPath) ? sftpAssetPath : undefined,
        sftpServerSha256Path: fs.existsSync(sftpAssetPath) ? maybeShaPath(sftpAssetPath) : undefined,
        source: 'pkg',
      };
    }
  }

  const binaryPath = sourceDropbearPath();
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
  const sftpServerPath = sourceSftpServerPath();
  const dropbearKeyPath = sourceDropbearKeyPath();

  return {
    binaryPath,
    sha256Path: maybeShaPath(binaryPath),
    dropbearKeyPath: fs.existsSync(dropbearKeyPath) ? dropbearKeyPath : undefined,
    dropbearKeySha256Path: fs.existsSync(dropbearKeyPath) ? maybeShaPath(dropbearKeyPath) : undefined,
    sftpServerPath: fs.existsSync(sftpServerPath) ? sftpServerPath : undefined,
    sftpServerSha256Path: fs.existsSync(sftpServerPath) ? maybeShaPath(sftpServerPath) : undefined,
    source: 'source',
  };
}
