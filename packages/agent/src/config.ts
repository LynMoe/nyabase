import { readFile } from 'node:fs/promises';
import { AGENT_CONTROL_PATH, AGENT_ENROLL_PATH, AGENT_STREAM_PATH } from '@nyabase/common';

export interface AgentConfig {
  /** Backend origin, e.g. https://nyabase.example.com */
  readonly backendUrl: URL;
  /** Extra CA bundle trusted for the Backend's TLS certificate. */
  readonly backendCa?: Buffer;
  readonly stateDir: string;
  /** One-time enrollment token; only read when no credential is stored yet. */
  readonly enrollmentToken?: string;
  readonly incusSocket: string;
  /**
   * Host bridges guest NICs may attach to (`NYABASE_AGENT_GUEST_BRIDGES`,
   * comma separated): the server's parent interface. Empty refuses every NIC.
   */
  readonly guestBridges: readonly string[];
}

export async function loadAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AgentConfig> {
  const backendUrl = parseBackendUrl(required(environment.NYABASE_BACKEND_URL, 'NYABASE_BACKEND_URL'));
  const caFile = environment.NYABASE_BACKEND_CA_FILE?.trim();
  if (caFile && backendUrl.protocol !== 'https:') {
    throw new Error('NYABASE_BACKEND_CA_FILE requires an https:// NYABASE_BACKEND_URL');
  }
  const enrollmentToken = environment.NYABASE_AGENT_ENROLLMENT_TOKEN?.trim() || undefined;
  return {
    backendUrl,
    backendCa: caFile ? await readFile(caFile) : undefined,
    stateDir: environment.NYABASE_AGENT_STATE_DIR?.trim() || '/var/lib/nyabase-agent',
    enrollmentToken,
    incusSocket: environment.INCUS_SOCKET?.trim() || '/var/lib/incus/unix.socket',
    guestBridges: parseGuestBridges(environment.NYABASE_AGENT_GUEST_BRIDGES ?? ''),
  };
}

/** A Linux interface name: 1-15 characters, no slash, whitespace or colon. */
const INTERFACE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,15}$/;

export function parseGuestBridges(value: string): string[] {
  const names = [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))];
  for (const name of names) {
    if (!INTERFACE_NAME_PATTERN.test(name) || name === '.' || name === '..') {
      throw new Error(`NYABASE_AGENT_GUEST_BRIDGES: ${JSON.stringify(name)} is not an interface name`);
    }
  }
  if (names.length > 64) throw new Error('NYABASE_AGENT_GUEST_BRIDGES lists more than 64 bridges');
  return names;
}

export function parseBackendUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NYABASE_BACKEND_URL must be an http(s) URL');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('NYABASE_BACKEND_URL must be a bare http(s) origin');
  }
  // The credential and every Incus request cross this link: plaintext only
  // where it never leaves the host (e.g. an ssh -R tunnel to loopback).
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('NYABASE_BACKEND_URL must use https:// unless the host is loopback');
  }
  return url;
}

/** localhost, 127.0.0.0/8 or ::1, as the WHATWG URL parser normalizes them. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

export function controlUrl(config: Pick<AgentConfig, 'backendUrl'>): string {
  return websocketUrl(config.backendUrl, AGENT_CONTROL_PATH);
}

export function streamUrl(config: Pick<AgentConfig, 'backendUrl'>, streamId: string): string {
  return `${websocketUrl(config.backendUrl, AGENT_STREAM_PATH)}?id=${encodeURIComponent(streamId)}`;
}

export function enrollUrl(config: Pick<AgentConfig, 'backendUrl'>): URL {
  return new URL(AGENT_ENROLL_PATH, config.backendUrl);
}

function websocketUrl(base: URL, path: string): string {
  const url = new URL(path, base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
