import { z } from 'zod';
import {
  DEFAULT_IMAGE_SOURCE_SERVER,
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
} from '../constants.js';

export const DEFAULT_NYABASE_CONFIG_FILE = '/etc/nyabase/config.yaml';

export type ConfigSourceName = 'default' | 'yaml' | 'env' | 'database';
export type ConfigSourceOrder = readonly ConfigSourceName[];
export type ConfigValueKind = 'string' | 'number' | 'boolean' | 'enum';

export interface ConfigFieldDefinition<T = unknown> {
  key: string;
  yamlPath: string;
  env: string;
  defaultValue: T;
  schema: z.ZodType<T>;
  valueKind: ConfigValueKind;
  sourceOrder: ConfigSourceOrder;
  secret: boolean;
  editable: boolean;
  restartRequired: boolean;
  public: boolean;
  label: string;
  description: string;
}

const sourceOrder = ['default', 'yaml', 'env'] as const;
const nonEmptyString = z.string().trim().min(1);
const optionalString = z.string().trim();
const developmentJwtSecret = 'change-me-in-production';
const jwtSecret = z.string().trim().refine(
  (value) => value === developmentJwtSecret || value.length >= 32,
  'Expected at least 32 characters',
);
const jwtLifetime = z.string().trim().regex(/^\d+(?:s|m|h|d)$/).refine((value) => {
  const amount = Number.parseInt(value, 10);
  const unit = value.at(-1);
  const milliseconds = amount * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit!] ?? 0);
  return milliseconds >= 60_000 && milliseconds <= 24 * 60 * 60_000;
}, 'Expected a duration between 1 minute and 24 hours');
const adminInitialPassword = z.string().refine(
  (value) => value === '' || (value.length >= 8 && value.length <= 256),
  'Expected an empty value or an 8-256 character password',
);
const proxyToken = z.string().refine(
  (value) => value === '' || /^[A-Za-z0-9_-]{32,1024}$/.test(value),
  'Expected an empty value or a 32-1024 character ASCII token using only letters, digits, _ or -',
);
const ipv4Octet = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const ipv4Address = new RegExp(`^${ipv4Octet}(\\.${ipv4Octet}){3}(/(3[0-2]|[12]?\\d))?$`);
const ipv6Address = /^[0-9a-f:.]*:[0-9a-f:.]*(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/i;
const trustedProxyPresets = new Set(['loopback', 'linklocal', 'uniquelocal']);
const trustedProxies = z.string().trim().refine(
  (value) => value === '' || value.split(',').every((entry) => {
    const candidate = entry.trim();
    return trustedProxyPresets.has(candidate) || ipv4Address.test(candidate) || ipv6Address.test(candidate);
  }),
  'Expected comma-separated IP addresses, CIDRs, or loopback/linklocal/uniquelocal',
);
const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();
const positiveDays = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();
const postgresUrl = z.string().trim().refine(
  (value) => /^postgres(?:ql)?:\/\/[^/\s]+\/[^?\s]+(?:\?.*)?$/.test(value),
  'Expected a PostgreSQL connection URL',
);

const booleanLike = z.union([z.boolean(), z.string(), z.number()]).transform((value, ctx) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Expected a boolean value',
  });
  return z.NEVER;
});

function field<T>(definition: Omit<ConfigFieldDefinition<T>, 'sourceOrder'>): ConfigFieldDefinition<T> {
  return { ...definition, sourceOrder };
}

export const controlPlaneConfigDefinitions = [
  field({
    key: 'runtime.nodeEnv',
    yamlPath: 'runtime.nodeEnv',
    env: 'NODE_ENV',
    defaultValue: 'development',
    schema: z.enum(['development', 'test', 'production']),
    valueKind: 'enum',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Node environment',
    description: 'Runtime environment used for production safety checks.',
  }),
  field({
    key: 'server.port',
    yamlPath: 'server.port',
    env: 'PORT',
    defaultValue: 3001,
    schema: port,
    valueKind: 'number',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'HTTP port',
    description: 'Backend HTTP port.',
  }),
  field({
    key: 'server.listenAddress',
    yamlPath: 'server.listenAddress',
    env: 'LISTEN_ADDRESS',
    defaultValue: '',
    schema: optionalString,
    valueKind: 'string',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'HTTP listen address',
    description: 'Address the backend binds. Empty listens on all interfaces. Lab should use 127.0.0.1 so the panel is only the edge proxy.',
  }),
  field({
    key: 'server.corsOrigin',
    yamlPath: 'server.corsOrigin',
    env: 'CORS_ORIGIN',
    defaultValue: '',
    schema: optionalString,
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: true,
    public: false,
    label: 'CORS origin',
    description: 'Allowed browser origin when the frontend is hosted separately.',
  }),
  field({
    key: 'server.trustedProxies',
    yamlPath: 'server.trustedProxies',
    env: 'TRUSTED_PROXIES',
    defaultValue: '',
    schema: trustedProxies,
    valueKind: 'string',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Trusted proxies',
    description: 'Comma-separated reverse proxy addresses/CIDRs (or loopback, linklocal, uniquelocal) whose X-Forwarded-For is trusted for client IPs. Empty trusts no proxy.',
  }),
  field({
    key: 'server.logLevel',
    yamlPath: 'server.logLevel',
    env: 'LOG_LEVEL',
    defaultValue: 'log',
    schema: z.enum(['error', 'warn', 'log', 'debug', 'verbose']),
    valueKind: 'enum',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Log level',
    description: 'Most verbose backend log level emitted. Levels above it are always included.',
  }),
  field({
    key: 'branding.title',
    yamlPath: 'branding.title',
    env: 'NYABASE_BRAND_TITLE',
    defaultValue: 'nyabase',
    schema: nonEmptyString.max(80),
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: false,
    public: true,
    label: 'Brand title',
    description: 'Product title shown in the login page and sidebar.',
  }),
  field({
    key: 'branding.description',
    yamlPath: 'branding.description',
    env: 'NYABASE_BRAND_DESCRIPTION',
    defaultValue: '开发容器管理平台',
    schema: nonEmptyString.max(160),
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: false,
    public: true,
    label: 'Brand description',
    description: 'Short login-page description.',
  }),
  field({
    key: 'auth.jwtSecret',
    yamlPath: 'auth.jwtSecret',
    env: 'JWT_SECRET',
    defaultValue: developmentJwtSecret,
    schema: jwtSecret,
    valueKind: 'string',
    secret: true,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'JWT secret',
    description: 'Secret used to sign browser and API JWTs.',
  }),
  field({
    key: 'auth.jwtExpiresIn',
    yamlPath: 'auth.jwtExpiresIn',
    env: 'JWT_EXPIRES_IN',
    defaultValue: '15m',
    schema: jwtLifetime,
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: true,
    public: false,
    label: 'JWT lifetime',
    description: 'Access-token lifetime passed to the JWT signer.',
  }),
  field({
    key: 'auth.refreshTokenExpiresDays',
    yamlPath: 'auth.refreshTokenExpiresDays',
    env: 'REFRESH_TOKEN_EXPIRES_DAYS',
    defaultValue: 7,
    schema: positiveDays.max(365),
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Refresh token days',
    description: 'Number of days before refresh tokens expire.',
  }),
  field({
    key: 'auth.cookieSecure',
    yamlPath: 'auth.cookieSecure',
    env: 'AUTH_COOKIE_SECURE',
    defaultValue: true,
    schema: booleanLike,
    valueKind: 'boolean',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Secure refresh cookie',
    description: 'Mark the HttpOnly refresh-session cookie Secure. Disable only for plain-HTTP development on a non-localhost host.',
  }),
  field({
    key: 'auth.adminInitPassword',
    yamlPath: 'auth.adminInitPassword',
    env: 'ADMIN_INIT_PASSWORD',
    defaultValue: '',
    schema: adminInitialPassword,
    valueKind: 'string',
    secret: true,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Initial admin password',
    description: 'Password used only when bootstrapping the first admin account.',
  }),
  field({
    key: 'incus.preflightImageAlias',
    yamlPath: 'incus.preflightImageAlias',
    env: 'INCUS_PREFLIGHT_IMAGE_ALIAS',
    defaultValue: '',
    schema: optionalString.max(256),
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Incus preflight image alias',
    description: 'Fixed simplestreams image alias used by server preflight probes.',
  }),
  field({
    key: 'incus.preflightImageFingerprint',
    yamlPath: 'incus.preflightImageFingerprint',
    env: 'INCUS_PREFLIGHT_IMAGE_FINGERPRINT',
    defaultValue: '',
    schema: optionalString.regex(/^(?:[0-9a-f]{64})?$/i),
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Incus preflight image fingerprint',
    description: 'Optional immutable image fingerprint used when an alias is not selected.',
  }),
  field({
    key: 'incus.preflightEgressUrl',
    yamlPath: 'incus.preflightEgressUrl',
    env: 'INCUS_PREFLIGHT_EGRESS_URL',
    defaultValue: '',
    schema: optionalString.max(2_048).refine(
      (value) => value === '' || /^https:\/\//.test(value),
      'Expected an empty value or an HTTPS egress URL',
    ),
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Incus preflight egress URL',
    description: 'Fixed HTTPS URL checked from the preflight container.',
  }),
  field({
    key: 'incus.preflightSourceServer',
    yamlPath: 'incus.preflightSourceServer',
    env: 'INCUS_PREFLIGHT_SOURCE_SERVER',
    defaultValue: DEFAULT_IMAGE_SOURCE_SERVER,
    schema: z.string().trim().url().refine((value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    }, 'Expected an HTTPS simplestreams source URL'),
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Incus preflight image source',
    description: 'HTTPS simplestreams source used for preflight probe images.',
  }),
  field({
    key: 'incus.imageSourceServer',
    yamlPath: 'incus.imageSourceServer',
    env: 'INCUS_IMAGE_SOURCE_URL',
    defaultValue: DEFAULT_IMAGE_SOURCE_SERVER,
    schema: optionalString.max(2_048).refine(
      (value) => {
        if (value === '') return true;
        try {
          return new URL(value).protocol === 'https:';
        } catch {
          return false;
        }
      },
      'Expected an empty value or an HTTPS simplestreams source URL',
    ),
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Incus image assignment source',
    description: 'HTTPS simplestreams source used for managed image pulls. Empty falls back to the preflight source.',
  }),
  field({
    key: 'containers.processLimit',
    yamlPath: 'containers.processLimit',
    env: 'CONTAINER_PROCESS_LIMIT',
    defaultValue: 4_096,
    schema: positiveInt.min(64).max(4_194_304),
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Container process limit',
    description: 'Maximum processes and threads per container (limits.processes).',
  }),
  field({
    key: 'containers.networkIngressMbit',
    yamlPath: 'containers.networkIngressMbit',
    env: 'CONTAINER_NETWORK_INGRESS_MBIT',
    defaultValue: 1_000,
    schema: positiveInt.min(1).max(400_000),
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Container ingress bandwidth',
    description: 'Per-container inbound bandwidth cap in Mbit/s (NIC limits.ingress).',
  }),
  field({
    key: 'containers.networkEgressMbit',
    yamlPath: 'containers.networkEgressMbit',
    env: 'CONTAINER_NETWORK_EGRESS_MBIT',
    defaultValue: 1_000,
    schema: positiveInt.min(1).max(400_000),
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Container egress bandwidth',
    description: 'Per-container outbound bandwidth cap in Mbit/s (NIC limits.egress).',
  }),
  field({
    key: 'containers.diskReadMBps',
    yamlPath: 'containers.diskReadMBps',
    env: 'CONTAINER_DISK_READ_MBPS',
    defaultValue: 500,
    schema: positiveInt.min(1).max(100_000),
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Container disk read rate',
    description: 'Per-disk read rate cap in MB/s for the root disk and local volumes (limits.read). Network filesystems (CephFS) cannot be throttled.',
  }),
  field({
    key: 'containers.diskWriteMBps',
    yamlPath: 'containers.diskWriteMBps',
    env: 'CONTAINER_DISK_WRITE_MBPS',
    defaultValue: 500,
    schema: positiveInt.min(1).max(100_000),
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Container disk write rate',
    description: 'Per-disk write rate cap in MB/s for the root disk and local volumes (limits.write). Network filesystems (CephFS) cannot be throttled.',
  }),
  field({
    key: 'incus.requestTimeoutMs',
    yamlPath: 'incus.requestTimeoutMs',
    env: 'INCUS_REQUEST_TIMEOUT_MS',
    defaultValue: 10_000,
    schema: positiveInt.min(1_000).max(120_000),
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Incus request timeout',
    description: 'Bounded timeout for one Incus API request.',
  }),
  field({
    key: 'incus.operationWaitTimeoutMs',
    yamlPath: 'incus.operationWaitTimeoutMs',
    env: 'INCUS_OPERATION_WAIT_TIMEOUT_MS',
    defaultValue: 120_000,
    schema: positiveInt.min(1_000).max(600_000),
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Incus operation wait timeout',
    description: 'Bounded wait for an asynchronous Incus operation.',
  }),
  field({
    key: 'database.url',
    yamlPath: 'database.url',
    env: 'DATABASE_URL',
    defaultValue: 'postgresql://nyabase:nyabase@postgres:5432/nyabase',
    schema: postgresUrl,
    valueKind: 'string',
    secret: true,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'PostgreSQL URL',
    description: 'PostgreSQL connection URL for the authoritative control-plane database.',
  }),
  field({
    key: 'database.poolMax',
    yamlPath: 'database.poolMax',
    env: 'DB_POOL_MAX',
    defaultValue: 20,
    schema: positiveInt.max(200),
    valueKind: 'number',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'PostgreSQL maximum pool size',
    description: 'Maximum number of PostgreSQL connections used by this process.',
  }),
  field({
    key: 'database.idleTimeoutMs',
    yamlPath: 'database.idleTimeoutMs',
    env: 'DB_IDLE_TIMEOUT_MS',
    defaultValue: 30_000,
    schema: positiveInt.min(1_000).max(600_000),
    valueKind: 'number',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'PostgreSQL idle timeout',
    description: 'Milliseconds before an idle pooled PostgreSQL connection is closed.',
  }),
  field({
    key: 'database.statementTimeoutMs',
    yamlPath: 'database.statementTimeoutMs',
    env: 'DB_STATEMENT_TIMEOUT_MS',
    defaultValue: 30_000,
    schema: positiveInt.min(1_000).max(600_000),
    valueKind: 'number',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'PostgreSQL statement timeout',
    description: 'Server-side timeout applied to application SQL statements.',
  }),
  field({
    key: 'database.migrationsRun',
    yamlPath: 'database.migrationsRun',
    env: 'DB_MIGRATIONS_RUN',
    defaultValue: true,
    schema: booleanLike,
    valueKind: 'boolean',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Run PostgreSQL migrations',
    description: 'Runs pending SQL-first PostgreSQL migrations while holding the migration advisory lock.',
  }),
  field({
    key: 'audit.retentionDays',
    yamlPath: 'audit.retentionDays',
    env: 'AUDIT_RETENTION_DAYS',
    defaultValue: 180,
    schema: nonNegativeInt,
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Audit retention days',
    description: 'Number of days to keep audit logs. Set to 0 to disable age-based cleanup.',
  }),
  field({
    key: 'audit.retentionMaxEntries',
    yamlPath: 'audit.retentionMaxEntries',
    env: 'AUDIT_RETENTION_MAX_ENTRIES',
    defaultValue: 100_000,
    schema: nonNegativeInt,
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'Audit max entries',
    description: 'Maximum number of audit logs to keep. Set to 0 to disable count-based cleanup.',
  }),
  field({
    key: 'metrics.victoriaMetricsUrl',
    yamlPath: 'metrics.victoriaMetricsUrl',
    env: 'VICTORIA_METRICS_URL',
    defaultValue: 'http://victoriametrics:8428',
    schema: nonEmptyString,
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: true,
    public: false,
    label: 'VictoriaMetrics URL',
    description: 'Base URL of VictoriaMetrics, used for metric ingestion (/api/v1/import/prometheus) and queries.',
  }),
  field({
    key: 'metrics.containerSeriesEnabled',
    yamlPath: 'metrics.containerSeriesEnabled',
    env: 'METRICS_CONTAINER_SERIES_ENABLED',
    defaultValue: true,
    schema: booleanLike,
    valueKind: 'boolean',
    secret: false,
    editable: true,
    restartRequired: true,
    public: false,
    label: 'Container performance series',
    description: 'When false, the control plane drops nyabase_container_* samples after a successful scrape and does not publish Incus disk or network series.',
  }),
  field({
    key: 'http.proxyToken',
    yamlPath: 'http.proxyToken',
    env: 'HTTP_PROXY_TOKEN',
    defaultValue: '',
    schema: proxyToken,
    valueKind: 'string',
    secret: true,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'HTTP proxy token',
    description: 'Bearer token used by the HTTP proxy process to connect to the backend.',
  }),
  field({
    key: 'ssh.keyEncryptionSecret',
    yamlPath: 'ssh.keyEncryptionSecret',
    env: 'SSH_KEY_ENCRYPTION_SECRET',
    defaultValue: '',
    schema: z.string().max(1024),
    valueKind: 'string',
    secret: true,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'SSH key encryption secret',
    description: 'Secret used to encrypt SSH proxy host keys, Incus client private keys, and HTTP-proxy TLS material stored in the database. Required in production; must not fall back to auth.jwtSecret.',
  }),
  field({
    key: 'ssh.proxyToken',
    yamlPath: 'ssh.proxyToken',
    env: 'SSH_PROXY_TOKEN',
    defaultValue: '',
    schema: proxyToken,
    valueKind: 'string',
    secret: true,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'SSH proxy token',
    description: 'Bearer token used by the SSH proxy process to connect to the backend.',
  }),
  field({
    key: 'ssh.proxyPublicHost',
    yamlPath: 'ssh.proxyPublicHost',
    env: 'SSH_PROXY_PUBLIC_HOST',
    defaultValue: '',
    schema: z.string().trim(),
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: false,
    public: true,
    label: 'SSH proxy public host',
    description: 'Hostname users should use when connecting through the SSH proxy.',
  }),
  field({
    key: 'ssh.proxyPublicPort',
    yamlPath: 'ssh.proxyPublicPort',
    env: 'SSH_PROXY_PUBLIC_PORT',
    defaultValue: 2222,
    schema: port,
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: true,
    label: 'SSH proxy public port',
    description: 'Port users should use when connecting through the SSH proxy.',
  }),
  field({
    key: 'ssh.proxySnapshotStaleMs',
    yamlPath: 'ssh.proxySnapshotStaleMs',
    env: 'SSH_PROXY_SNAPSHOT_STALE_MS',
    defaultValue: 300_000,
    schema: positiveInt
      .min(SSH_PROXY_SNAPSHOT_STALE_MIN_MS)
      .max(SSH_PROXY_SNAPSHOT_STALE_MAX_MS),
    valueKind: 'number',
    secret: false,
    editable: true,
    restartRequired: false,
    public: false,
    label: 'SSH proxy snapshot staleness',
    description: 'Milliseconds before an SSH proxy snapshot is considered stale (120000-300000).',
  }),
] as const satisfies readonly ConfigFieldDefinition[];

export type ControlPlaneConfigDefinition = (typeof controlPlaneConfigDefinitions)[number];
export type ControlPlaneConfigKey = ControlPlaneConfigDefinition['key'];
export const controlPlaneConfigManifest = controlPlaneConfigDefinitions.map((definition) => ({
  key: definition.key,
  yamlPath: definition.yamlPath,
  env: definition.env,
  defaultValue: definition.defaultValue,
  valueKind: definition.valueKind,
  sourceOrder: [...definition.sourceOrder],
  secret: definition.secret,
  editable: definition.editable,
  restartRequired: definition.restartRequired,
  public: definition.public,
  label: definition.label,
  description: definition.description,
}));

export function getControlPlaneConfigDefinition(key: string): ControlPlaneConfigDefinition | undefined {
  return controlPlaneConfigDefinitions.find((definition) => definition.key === key);
}
