import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RunServer {
  index: number;
  id: string;
  slug: string;
  /** SSH target of the lab host (`local` = this machine). Used by cleanup only. */
  ssh: string;
  apiEndpoint: string;
  /** Registered pool that holds root disks and local volumes. */
  poolId: string;
  poolName: string;
  /** Registered executor pool of the shared backend on this server, if any. */
  sharedPoolId: string | null;
  /** PCI address of a GPU on this host that the GPU scenarios may use. */
  gpuPci: string | null;
}

/** Everything `e2e.sh up` learned; written to `<run dir>/state.json`. */
export interface RunState {
  runId: string;
  runDir: string;
  baseUrl: string;
  /** Connection URL of the run's database (scenarios write lapse times into it). */
  databaseUrl: string;
  admin: { username: string; password: string };
  sshProxy: { host: string; port: number };
  httpProxy: { host: string; port: number };
  servers: RunServer[];
  ipPoolId: string;
  image: { id: string; alias: string };
  sharedBackendId: string | null;
  incusClientFingerprint: string;
  rootSizeBytes: number;
  /** Free LAN address the preflight probe instance takes. */
  probeAddress: string;
}

function runDirFromEnv(): string | null {
  if (process.env.E2E_RUN_DIR) return process.env.E2E_RUN_DIR;
  const root = process.env.E2E_RUN_ROOT;
  if (!root) return null;
  const pointer = join(root, 'current');
  if (!existsSync(pointer)) return null;
  const id = readFileSync(pointer, 'utf8').trim();
  return id ? join(root, id) : null;
}

/** Null when no run exists (the scenario files must still load). */
export function tryLoadState(): RunState | null {
  const dir = runDirFromEnv();
  if (!dir) return null;
  const file = join(dir, 'state.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as RunState;
}

export function loadState(): RunState {
  const state = tryLoadState();
  if (!state) throw new Error('no e2e run state found: run `bash tests/e2e/e2e.sh up` first');
  return state;
}
