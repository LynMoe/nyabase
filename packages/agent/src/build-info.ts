import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What `scripts/build-agent-bundle.sh` writes next to the bundle's package.json. */
export const BUILD_INFO_FILE = 'build-info.json';

export interface AgentBuild {
  /** Reported in hello and shown on the server: `<package version>+g<commit>[.dirty]`. */
  readonly version: string;
  readonly commit: string | null;
}

/**
 * The build this process runs. A bundle carries the commit it was built
 * from; anything else (a workspace `tsc` build, `tsx`) says it is unbundled
 * so a host never reports a version it cannot be traced back to.
 */
export function readAgentBuild(root: string = join(__dirname, '..')): AgentBuild {
  const info = readJson(join(root, BUILD_INFO_FILE));
  if (typeof info?.version === 'string' && info.version.trim()) {
    return {
      version: info.version.trim().slice(0, 64),
      commit: typeof info.commit === 'string' ? info.commit : null,
    };
  }
  const manifest = readJson(join(root, 'package.json'));
  const version = typeof manifest?.version === 'string' ? manifest.version : '0.0.0';
  return { version: `${version}+unbundled`.slice(0, 64), commit: null };
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
