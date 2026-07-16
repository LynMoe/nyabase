import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import {
  canonicalIpv4Address,
  canonicalIpv4Cidr,
  ipToNum,
  numToIp,
  parseCidr,
  MAX_AGENT_LOCAL_DATA_SOURCES,
  MAX_AGENT_MACVLAN_RESERVED_IPS,
} from '@nyabase/common';
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
        if (u.protocol === 'wss:') return true;
        return u.protocol === 'ws:'
          && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1');
      } catch {
        return false;
      }
    }, 'backendUrl must use wss://; ws:// is allowed only for a loopback development endpoint'),
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
  reservedIps: z.array(z.string()).max(MAX_AGENT_MACVLAN_RESERVED_IPS),
  metricsIntervalMs: z.number().int().min(5_000).max(300_000),
  /** If false, the agent skips nvidia-smi probing and emits no GPU metrics. */
  isGpuServer: z.boolean(),
  dockerResourceLimit: z.object({
    enabled: z.boolean(),
  }),
  localDataSources: z.array(z.object({
    id: z.string().min(1, 'localDataSources.id is required'),
    mountPoint: z
      .string()
      .refine((v) => path.isAbsolute(v), 'localDataSources.mountPoint must be an absolute path'),
    label: z.string().max(128).optional(),
  })).max(MAX_AGENT_LOCAL_DATA_SOURCES).default([]),
}).strict().superRefine((value, ctx) => {
  const normalizedDockerRoot = path.resolve(value.dockerRoot);
  const remoteFsRoot = path.resolve('/mnt/remote-fs');
  const isInside = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative === ''
      || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const overlaps = (a: string, b: string) => {
    const relative = path.relative(a, b);
    const reverse = path.relative(b, a);
    const inside = (candidate: string) => candidate === ''
      || (candidate !== '..' && !candidate.startsWith(`..${path.sep}`) && !path.isAbsolute(candidate));
    return inside(relative) || inside(reverse);
  };
  if (overlaps(normalizedDockerRoot, remoteFsRoot)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dockerRoot'],
      message: 'dockerRoot must not overlap /mnt/remote-fs',
    });
  }
  if (normalizedDockerRoot !== value.dockerRoot) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dockerRoot'],
      message: 'dockerRoot must be an absolute normalized path without dot segments or a trailing slash',
    });
  }
  const protectedSystemRoots = [
    '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/proc',
    '/root', '/run', '/sbin', '/sys', '/tmp', '/usr',
  ];
  const protectedRoot = protectedSystemRoots.find((root) => isInside(root, normalizedDockerRoot));
  if (normalizedDockerRoot === '/' || normalizedDockerRoot === '/var' || normalizedDockerRoot === '/var/lib' || protectedRoot) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dockerRoot'],
      message: `dockerRoot must be a dedicated data filesystem, not ${protectedRoot ?? normalizedDockerRoot}`,
    });
  }

  try {
    const { base, prefixLen } = parseCidr(value.macvlanCidr);
    if (prefixLen < 16 || prefixLen > 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['macvlanCidr'],
        message: 'macvlanCidr prefix must be between /16 and /30',
      });
    }
    const size = 2 ** (32 - prefixLen);
    const network = Math.floor(ipToNum(base) / size) * size;
    const broadcast = network + size - 1;
    if (ipToNum(base) !== network) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['macvlanCidr'],
        message: `macvlanCidr must use its canonical network address ${numToIp(network)}/${prefixLen}`,
      });
    }
    if (canonicalIpv4Cidr(value.macvlanCidr) !== value.macvlanCidr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['macvlanCidr'],
        message: 'macvlanCidr must use one canonical IPv4 representation',
      });
    }
    const addresses = [value.macvlanGateway, ...value.reservedIps];
    const seen = new Set<number>();
    addresses.forEach((address, index) => {
      const issuePath: Array<string | number> = index === 0
        ? ['macvlanGateway']
        : ['reservedIps', index - 1];
      try {
        const numeric = ipToNum(address);
        if (canonicalIpv4Address(address) !== address) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: issuePath,
            message: `${address} must use canonical IPv4 notation`,
          });
        }
        if (numeric <= network || numeric >= broadcast) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: issuePath,
            message: `${address} must be a usable host address inside macvlanCidr`,
          });
        }
        if (seen.has(numeric)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: issuePath,
            message: `${address} duplicates the gateway or another reserved IP`,
          });
        }
        seen.add(numeric);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issuePath,
          message: `${address} is not a valid IPv4 address`,
        });
      }
    });
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['macvlanCidr'],
      message: error instanceof Error ? error.message : 'Invalid macvlanCidr',
    });
  }
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value.parentIface)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parentIface'],
      message: 'parentIface contains unsupported characters',
    });
  }
  const ids = new Set<string>();
  const mountPoints: Array<{ index: number; value: string }> = [];
  for (const [index, source] of value.localDataSources.entries()) {
    if (ids.has(source.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localDataSources', index, 'id'],
        message: `Duplicate local data source id: ${source.id}`,
      });
    }
    ids.add(source.id);

    const mountPoint = path.resolve(source.mountPoint);
    if (mountPoint !== source.mountPoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localDataSources', index, 'mountPoint'],
        message: 'mountPoint must be an absolute normalized path without dot segments or a trailing slash',
      });
    }
    const conflict = mountPoints.find((entry) => overlaps(entry.value, mountPoint));
    if (conflict) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localDataSources', index, 'mountPoint'],
        message: `Local data source mountPoint overlaps entry ${conflict.index}: ${source.mountPoint}`,
      });
    }
    if (overlaps(mountPoint, normalizedDockerRoot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localDataSources', index, 'mountPoint'],
        message: `Local data source mountPoint must not overlap dockerRoot: ${source.mountPoint}`,
      });
    }
    if (overlaps(mountPoint, remoteFsRoot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localDataSources', index, 'mountPoint'],
        message: `Local data source mountPoint must not overlap ${remoteFsRoot}`,
      });
    }
    mountPoints.push({ index, value: mountPoint });
  }
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

export function resolveAgentVersion(): string {
  return readPackageVersion() ?? readInjectedAgentVersion() ?? DEVELOPMENT_AGENT_VERSION_FALLBACK;
}

function loadRaw(): { raw: Record<string, unknown>; sourcePath: string | null } {
  const configArgIdx = process.argv.indexOf('--config');
  if (configArgIdx !== -1 && process.argv[configArgIdx + 1]) {
    const configPath = process.argv[configArgIdx + 1];
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    return {
      raw: (yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>) ?? {},
      sourcePath: configPath,
    };
  }

  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) {
      return {
        raw: (yaml.load(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>) ?? {},
        sourcePath: p,
      };
    }
  }

  // Env-only fallback (dev/testing)
  return { raw: {
    backendUrl: process.env.BACKEND_URL,
    agentToken: process.env.AGENT_TOKEN,
    serverId: process.env.SERVER_ID,
    dockerRoot: process.env.DOCKER_ROOT,
    parentIface: process.env.PARENT_IFACE,
    macvlanCidr: process.env.MACVLAN_CIDR,
    macvlanGateway: process.env.MACVLAN_GATEWAY,
    reservedIps: process.env.RESERVED_IPS,
    metricsIntervalMs: process.env.METRICS_INTERVAL_MS,
    isGpuServer: process.env.IS_GPU_SERVER,
    dockerResourceLimit: process.env.DOCKER_RESOURCE_LIMIT_ENABLED === undefined
      ? undefined
      : { enabled: process.env.DOCKER_RESOURCE_LIMIT_ENABLED },
    localDataSources: process.env.LOCAL_DATA_SOURCES,
  }, sourcePath: null };
}

function assertConfigFilePrivate(configPath: string): void {
  const stat = fs.statSync(configPath);
  const exposedMode = stat.mode & 0o077;
  if (exposedMode !== 0) {
    throw new Error(`Config file ${configPath} contains Agent credentials and must have mode 0600 or stricter`);
  }
  const effectiveUid = process.geteuid?.();
  if (effectiveUid !== undefined && stat.uid !== effectiveUid) {
    throw new Error(`Config file ${configPath} must be owned by the Agent process uid ${effectiveUid}`);
  }
}

function coerceShape(raw: Record<string, unknown>): Record<string, unknown> {
  const metricsRaw = raw.metricsIntervalMs;
  const isGpuRaw = raw.isGpuServer;
  const dockerResourceLimitRaw = raw.dockerResourceLimit as Record<string, unknown> | undefined;
  const dockerResourceLimitEnabledRaw = dockerResourceLimitRaw?.enabled;

  function coerceLocalDataSources(rawSources: unknown) {
    let sources = rawSources;
    if (typeof sources === 'string') {
      const trimmed = sources.trim();
      sources = trimmed ? yaml.load(trimmed) : [];
    }
    if (!Array.isArray(sources)) return [];
    return sources.map((source) => {
      const src = source as Record<string, unknown>;
      return {
        id: String(src.id ?? ''),
        mountPoint: String(src.mountPoint ?? ''),
        ...(src.label == null ? {} : { label: String(src.label) }),
      };
    });
  }

  return {
    // Preserve unknown top-level keys so the strict schema rejects retired
    // configuration instead of silently reviving a compatibility path.
    ...raw,
    backendUrl: raw.backendUrl ?? 'ws://localhost:3001/ws/agent',
    agentToken: raw.agentToken ?? '',
    serverId: raw.serverId ?? '',
    dockerRoot: raw.dockerRoot ?? '/var/lib/nyabase-docker',
    parentIface: raw.parentIface ?? 'eth0',
    macvlanCidr: raw.macvlanCidr ?? '192.168.100.0/24',
    macvlanGateway: raw.macvlanGateway ?? '192.168.100.1',
    reservedIps: Array.isArray(raw.reservedIps)
      ? raw.reservedIps.map((v) => String(v))
      : typeof raw.reservedIps === 'string'
      ? raw.reservedIps.split(',').map((v) => v.trim()).filter(Boolean)
      : [],
    metricsIntervalMs:
      typeof metricsRaw === 'string'
        ? parseInt(metricsRaw, 10)
        : typeof metricsRaw === 'number'
        ? metricsRaw
        : 10_000,
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
    localDataSources: coerceLocalDataSources(raw.localDataSources),
  };
}

export function parseAgentConfig(raw: Record<string, unknown>): AgentConfig {
  const parsed = zAgentConfig.parse(coerceShape(raw));
  return { ...parsed, agentVersion: resolveAgentVersion() };
}

/** Load + validate the agent configuration. Exits the process on validation errors. */
export function loadAgentConfig(): AgentConfig {
  try {
    const loaded = loadRaw();
    if (loaded.sourcePath) assertConfigFilePrivate(loaded.sourcePath);
    return parseAgentConfig(loaded.raw);
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
}
