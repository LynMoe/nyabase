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
    .max(2048, 'backendUrl is too long')
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
    .min(16, 'agentToken must be at least 16 characters')
    .max(256, 'agentToken is too long'),
  serverId: z
    .string()
    .min(1, 'serverId is required')
    .max(128, 'serverId is too long')
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'serverId contains unsupported characters'),
  /**
   * Docker data-root directory. Written to the nyabase-docker.service unit file.
   * Immutable after first deployment — changing it requires migrating all
   * Docker data on the host manually.
   */
  dockerRoot: z
    .string()
    .regex(
      /^\/[A-Za-z0-9._/-]+$/,
      'dockerRoot must contain only systemd-safe path characters',
    )
    .refine((v) => path.isAbsolute(v), 'dockerRoot must be an absolute path'),
  parentIface: z.string().min(1).max(64),
  macvlanCidr: z.string().min(1).max(18),
  macvlanGateway: z.string().min(7).max(15),
  reservedIps: z.array(z.string().min(7).max(15)).max(MAX_AGENT_MACVLAN_RESERVED_IPS),
  metricsIntervalMs: z.number().int().min(5_000).max(300_000),
  /** If false, the agent skips nvidia-smi probing and emits no GPU metrics. */
  isGpuServer: z.boolean(),
  dockerResourceLimit: z.object({
    enabled: z.boolean(),
  }).strict(),
  localDataSources: z.array(z.object({
    id: z.string()
      .min(1, 'localDataSources.id is required')
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'localDataSources.id contains unsupported characters'),
    mountPoint: z
      .string()
      .max(4096)
      .refine((value) => !/[\0\r\n]/.test(value), 'localDataSources.mountPoint contains control characters')
      .refine((v) => path.isAbsolute(v), 'localDataSources.mountPoint must be an absolute path'),
    label: z.string().max(128).optional(),
  }).strict()).max(MAX_AGENT_LOCAL_DATA_SOURCES).default([]),
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
  const defaultWhenAbsent = (value: unknown, fallback: unknown) =>
    value === undefined ? fallback : value;
  const coerceExactInteger = (value: unknown, fallback: number): unknown => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string') return value;
    if (!/^(?:0|[1-9]\d*)$/.test(value)) return value;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  };
  const coerceExactBoolean = (value: unknown, fallback: boolean): unknown => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  };
  const coerceReservedIps = (value: unknown): unknown => {
    if (value === undefined) return [];
    if (typeof value !== 'string') return value;
    if (value.trim() === '') return [];
    const entries = value.split(',').map((entry) => entry.trim());
    return entries.some((entry) => entry.length === 0) ? value : entries;
  };
  const coerceLocalDataSources = (value: unknown): unknown => {
    if (value === undefined) return [];
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed === '') return [];
    return yaml.load(trimmed);
  };
  const coerceDockerResourceLimit = (value: unknown): unknown => {
    if (value === undefined) return { enabled: false };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, 'enabled')) return record;
    const enabled = record.enabled;
    return {
      ...record,
      enabled: typeof enabled === 'string'
        ? coerceExactBoolean(enabled, false)
        : enabled,
    };
  };

  return {
    // Preserve unknown top-level keys so the strict schema rejects retired
    // configuration instead of silently reviving a compatibility path.
    ...raw,
    backendUrl: defaultWhenAbsent(raw.backendUrl, 'ws://localhost:3001/ws/agent'),
    agentToken: defaultWhenAbsent(raw.agentToken, ''),
    serverId: defaultWhenAbsent(raw.serverId, ''),
    dockerRoot: defaultWhenAbsent(raw.dockerRoot, '/var/lib/nyabase-docker'),
    parentIface: defaultWhenAbsent(raw.parentIface, 'eth0'),
    macvlanCidr: defaultWhenAbsent(raw.macvlanCidr, '192.168.100.0/24'),
    macvlanGateway: defaultWhenAbsent(raw.macvlanGateway, '192.168.100.1'),
    reservedIps: coerceReservedIps(raw.reservedIps),
    metricsIntervalMs: coerceExactInteger(raw.metricsIntervalMs, 10_000),
    isGpuServer: coerceExactBoolean(raw.isGpuServer, true),
    dockerResourceLimit: coerceDockerResourceLimit(raw.dockerResourceLimit),
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
