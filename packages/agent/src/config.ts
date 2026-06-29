import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { type DockerResourceLimitConfig } from './docker/resource-limits.js';

/**
 * Schema for the on-disk agent.yaml file (or env-derived equivalent).
 *
 * Fail-fast: missing/invalid critical fields cause the agent to exit on boot.
 * No backward-compat shims for retired fields (e.g. `dataDisks`, `dockerSocket`,
 * `xfsMount`, `overlayMount`). The agent always talks to its own
 * nyabase-managed dockerd at a fixed socket path (`DaemonManager.SOCKET_PATH`),
 * so a configurable docker socket would be misleading.
 */
const zAgentConfig = z.object({
  backendUrl: z
    .string()
    .min(1, 'backendUrl is required')
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'ws:' || u.protocol === 'wss:' || u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'backendUrl must be a valid ws://, wss://, http:// or https:// URL'),
  agentToken: z
    .string()
    .min(16, 'agentToken must be at least 16 characters'),
  serverId: z
    .string()
    .min(1, 'serverId is required'),
  /**
   * Docker data-root directory. Written to the nyabase-docker.service unit file.
   * Immutable after first deployment — changing it requires migrating all
   * Docker data on the host manually.
   */
  dockerRoot: z
    .string()
    .refine((v) => path.isAbsolute(v), 'dockerRoot must be an absolute path'),
  parentIface: z.string().min(1),
  macvlanCidr: z.string().min(1),
  macvlanGateway: z.string().min(1),
  metricsIntervalMs: z.number().int().positive(),
  mountHelperPath: z.string().min(1),
  /** If false, the agent skips nvidia-smi probing and emits no GPU metrics. */
  isGpuServer: z.boolean(),
  dockerResourceLimit: z.object({
    enabled: z.boolean(),
  }),
});

export type AgentConfig = z.infer<typeof zAgentConfig> & {
  /** Resolved at load time from package.json or from an official build-time injection. */
  agentVersion: string;
};

const CONFIG_PATHS = ['/etc/nyabase/agent.yaml', './agent.yaml'];
const DEVELOPMENT_AGENT_VERSION_FALLBACK = '0.0.0-dev';

function normalizeAgentVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPackageVersion(): string | null {
  // Walk the source-mode and compiled-install layouts before using bundled fallback data.
  const candidates = [
    path.join(__dirname, '../package.json'),
    path.join(__dirname, '../../package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf-8')) as { name?: string; version?: string };
      if (pkg.name === '@nyabase/agent') {
        const version = normalizeAgentVersion(pkg.version);
        if (version) return version;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function readInjectedAgentVersion(): string | null {
  // Official standalone builds replace this env lookup with a string literal.
  return normalizeAgentVersion(process.env.NYABASE_AGENT_VERSION);
}

function resolveAgentVersion(): string {
  return readPackageVersion() ?? readInjectedAgentVersion() ?? DEVELOPMENT_AGENT_VERSION_FALLBACK;
}

function loadRaw(): Record<string, unknown> {
  const configArgIdx = process.argv.indexOf('--config');
  if (configArgIdx !== -1 && process.argv[configArgIdx + 1]) {
    const configPath = process.argv[configArgIdx + 1];
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    return (yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>) ?? {};
  }

  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) {
      return (yaml.load(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>) ?? {};
    }
  }

  // Env-only fallback (dev/testing)
  return {
    backendUrl: process.env.BACKEND_URL,
    agentToken: process.env.AGENT_TOKEN,
    serverId: process.env.SERVER_ID,
    dockerRoot: process.env.DOCKER_ROOT,
    parentIface: process.env.PARENT_IFACE,
    macvlanCidr: process.env.MACVLAN_CIDR,
    macvlanGateway: process.env.MACVLAN_GATEWAY,
    metricsIntervalMs: process.env.METRICS_INTERVAL_MS,
    mountHelperPath: process.env.MOUNT_HELPER_PATH,
    isGpuServer: process.env.IS_GPU_SERVER,
    dockerResourceLimit: process.env.DOCKER_RESOURCE_LIMIT_ENABLED === undefined
      ? undefined
      : { enabled: process.env.DOCKER_RESOURCE_LIMIT_ENABLED },
  };
}

function coerceShape(raw: Record<string, unknown>): Record<string, unknown> {
  const metricsRaw = raw.metricsIntervalMs;
  const isGpuRaw = raw.isGpuServer;
  const dockerResourceLimitRaw = raw.dockerResourceLimit as Record<string, unknown> | undefined;
  const dockerResourceLimitEnabledRaw = dockerResourceLimitRaw?.enabled;
  return {
    backendUrl: raw.backendUrl ?? 'ws://localhost:3001/ws/agent',
    agentToken: raw.agentToken ?? '',
    serverId: raw.serverId ?? '',
    dockerRoot: raw.dockerRoot ?? '/var/lib/nyabase-docker',
    parentIface: raw.parentIface ?? 'eth0',
    macvlanCidr: raw.macvlanCidr ?? '192.168.100.0/24',
    macvlanGateway: raw.macvlanGateway ?? '192.168.100.1',
    metricsIntervalMs:
      typeof metricsRaw === 'string'
        ? parseInt(metricsRaw, 10)
        : typeof metricsRaw === 'number'
        ? metricsRaw
        : 10_000,
    mountHelperPath: raw.mountHelperPath ?? '/var/lib/nyabase-agent/nyabase-mount-helper',
    isGpuServer:
      typeof isGpuRaw === 'boolean'
        ? isGpuRaw
        : typeof isGpuRaw === 'string'
        ? isGpuRaw !== 'false' && isGpuRaw !== '0' && isGpuRaw !== ''
        : true,
    dockerResourceLimit: {
      enabled:
        typeof dockerResourceLimitEnabledRaw === 'boolean'
          ? dockerResourceLimitEnabledRaw
          : typeof dockerResourceLimitEnabledRaw === 'string'
          ? dockerResourceLimitEnabledRaw !== 'false' && dockerResourceLimitEnabledRaw !== '0' && dockerResourceLimitEnabledRaw !== ''
          : false,
    } satisfies DockerResourceLimitConfig,
  };
}

/** Load + validate the agent configuration. Exits the process on validation errors. */
export function loadAgentConfig(): AgentConfig {
  let parsed: z.infer<typeof zAgentConfig>;
  try {
    parsed = zAgentConfig.parse(coerceShape(loadRaw()));
  } catch (err) {
    console.error('[Agent] Invalid configuration:');
    if (err instanceof z.ZodError) {
      for (const issue of err.errors) {
        console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
    } else {
      console.error(`  - ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
  return { ...parsed, agentVersion: resolveAgentVersion() };
}

/** @deprecated Kept for older callers; new code should use `loadAgentConfig`. */
export const loadConfig = loadAgentConfig;
