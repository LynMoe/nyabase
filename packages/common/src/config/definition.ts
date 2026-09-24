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
const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();
const positiveDays = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();
const postgresUrl = z.string().trim().refine(
  (value) => /^postgres(?:ql)?:\/\/[^/\s]+\/[^?\s]+(?:\?.*)?$/.test(value),
  'Expected a PostgreSQL connection URL',
);

const MAX_REDIS_URL_BYTES = 2_048;
const MAX_REDIS_USERNAME_BYTES = 128;
const MAX_REDIS_PASSWORD_BYTES = 1_024;
const MAX_REDIS_DATABASE = 2_147_483_647;

/**
 * Parses the exact Redis URL subset supported by Nyabase.
 *
 * TLS is selected only by the scheme and its verification settings live in
 * dedicated config fields, so query parameters cannot weaken or conflict with
 * the transport policy. Redis ACL credentials remain supported while malformed
 * or unbounded user-info is rejected before it reaches node-redis.
 */
export function parseRedisConnectionUrl(value: string): URL {
  if (
    value !== value.trim()
    || new TextEncoder().encode(value).byteLength > MAX_REDIS_URL_BYTES
  ) {
    throw new Error('Invalid Redis connection URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid Redis connection URL');
  }

  if (
    (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:')
    || parsed.hostname === ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !/^\/(?:0|[1-9]\d*)$/.test(parsed.pathname)
  ) {
    throw new Error('Invalid Redis connection URL');
  }

  const database = Number(parsed.pathname.slice(1));
  if (!Number.isSafeInteger(database) || database > MAX_REDIS_DATABASE) {
    throw new Error('Invalid Redis connection URL');
  }

  if (parsed.port !== '') {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Invalid Redis connection URL');
    }
  }

  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new Error('Invalid Redis connection URL');
  }

  if (
    (username !== '' && password === '')
    || (username !== '' && !/^[A-Za-z0-9._-]+$/.test(username))
    || credentialByteLength(username) > MAX_REDIS_USERNAME_BYTES
    || credentialByteLength(password) > MAX_REDIS_PASSWORD_BYTES
    || /[\u0000-\u001f\u007f]/.test(password)
  ) {
    throw new Error('Invalid Redis connection URL');
  }

  return parsed;
}

function isRedisConnectionUrl(value: string): boolean {
  try {
    parseRedisConnectionUrl(value);
    return true;
  } catch {
    return false;
  }
}

function credentialByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const redisUrl = z.string().trim().refine(
  isRedisConnectionUrl,
  'Expected a canonical redis(s) URL with a hostname, /<database> path, optional bounded credentials, and no query or fragment',
);
const consolePublicUrl = z.string().trim()
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 2_048,
    'Expected at most 2048 UTF-8 bytes',
  )
  .refine((value) => {
    if (value === '') return true;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:')
        && parsed.username === ''
        && parsed.password === ''
        && parsed.search === ''
        && parsed.hash === ''
        && parsed.pathname === '/ws/console';
    } catch {
      return false;
    }
  }, 'Expected an empty value or an absolute ws(s) URL ending in /ws/console');
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
    key: 'runtime.role',
    yamlPath: 'runtime.role',
    env: 'NYABASE_RUNTIME_ROLE',
    defaultValue: 'all',
    valueKind: 'enum',
    schema: z.enum(['all', 'api', 'worker']),
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Runtime role',
    description: 'Process role to run: all-in-one, API, or control worker. Node-exporter is a separate process.',
  }),
  field({
    key: 'runtime.consolePublicUrl',
    yamlPath: 'runtime.consolePublicUrl',
    env: 'NYABASE_CONSOLE_PUBLIC_URL',
    defaultValue: '',
    valueKind: 'string',
    schema: consolePublicUrl,
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Console public URL',
    description: 'Browser-reachable ws(s) URL for the console bridge; empty keeps the same-origin relative URL.',
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
    key: 'incus.clientCertificateFile',
    yamlPath: 'incus.clientCertificateFile',
    env: 'INCUS_CLIENT_CERT_FILE',
    defaultValue: '/run/secrets/incus_client_cert',
    schema: nonEmptyString.max(4_096),
    valueKind: 'string',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Incus client certificate file',
    description: 'Read-only PEM file injected into the backend for Incus mTLS bootstrap.',
  }),
  field({
    key: 'incus.clientPrivateKeyFile',
    yamlPath: 'incus.clientPrivateKeyFile',
    env: 'INCUS_CLIENT_KEY_FILE',
    defaultValue: '/run/secrets/incus_client_key',
    schema: nonEmptyString.max(4_096),
    valueKind: 'string',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Incus client private key file',
    description: 'Read-only PEM file injected into the backend for first-time Incus mTLS bootstrap.',
  }),
  field({
    key: 'incus.caFile',
    yamlPath: 'incus.caFile',
    env: 'INCUS_CA_FILE',
    defaultValue: '/run/secrets/incus_ca',
    schema: nonEmptyString.max(4_096),
    valueKind: 'string',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Incus server CA file',
    description: 'PEM CA bundle or self-signed Incus server certificate used with TLS verification.',
  }),
  field({
    key: 'incus.clientCertificatePem',
    yamlPath: 'incus.clientCertificatePem',
    env: 'INCUS_CLIENT_CERT_PEM',
    defaultValue: '',
    schema: optionalString.max(128 * 1024),
    valueKind: 'string',
    secret: true,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Incus client certificate PEM',
    description: 'Optional inline bootstrap certificate; the injected file remains the deployment default.',
  }),
  field({
    key: 'incus.clientPrivateKeyPem',
    yamlPath: 'incus.clientPrivateKeyPem',
    env: 'INCUS_CLIENT_KEY_PEM',
    defaultValue: '',
    schema: optionalString.max(128 * 1024),
    valueKind: 'string',
    secret: true,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Incus client private key PEM',
    description: 'Optional inline bootstrap private key; the injected file remains the deployment default.',
  }),
  field({
    key: 'incus.caPem',
    yamlPath: 'incus.caPem',
    env: 'INCUS_CA_PEM',
    defaultValue: '',
    schema: optionalString.max(256 * 1024),
    valueKind: 'string',
    secret: true,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Incus server CA PEM',
    description: 'Optional inline CA bundle or self-signed server certificate for verified Incus TLS.',
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
    key: 'redis.url',
    yamlPath: 'redis.url',
    env: 'REDIS_URL',
    defaultValue: 'redis://redis:6379/0',
    schema: redisUrl,
    valueKind: 'string',
    secret: true,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Redis URL',
    description: 'Redis connection URL for addressed split-role RPC, disposable cache/wakes, and shared rate limits. Use rediss:// in production across hosts.',
  }),
  field({
    key: 'redis.keyPrefix',
    yamlPath: 'redis.keyPrefix',
    env: 'REDIS_KEY_PREFIX',
    defaultValue: 'nyabase:',
    schema: z.string().trim().regex(/^[A-Za-z0-9:_-]{1,64}$/),
    valueKind: 'string',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Redis key prefix',
    description: 'Namespace prefix applied to every disposable Redis key and channel.',
  }),
  field({
    key: 'redis.tlsCaFile',
    yamlPath: 'redis.tlsCaFile',
    env: 'REDIS_TLS_CA_FILE',
    defaultValue: '',
    schema: optionalString,
    valueKind: 'string',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Redis TLS CA file',
    description: 'Optional PEM CA bundle for a rediss:// private-CA endpoint. Certificate verification cannot be disabled.',
  }),
  field({
    key: 'redis.tlsServername',
    yamlPath: 'redis.tlsServername',
    env: 'REDIS_TLS_SERVERNAME',
    defaultValue: '',
    schema: optionalString.max(253).refine(
      (value) => value === '' || /^[A-Za-z0-9.-]+$/.test(value),
      'Expected an empty value or a DNS server name',
    ),
    valueKind: 'string',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Redis TLS server name',
    description: 'Optional certificate server name override for a rediss:// endpoint.',
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
    description: 'Base URL used only for VictoriaMetrics queries.',
  }),
  field({
    key: 'metrics.vmagentUrl',
    yamlPath: 'metrics.vmagentUrl',
    env: 'VMAGENT_URL',
    defaultValue: 'http://vmagent:8429',
    schema: nonEmptyString,
    valueKind: 'string',
    secret: false,
    editable: true,
    restartRequired: true,
    public: false,
    label: 'vmagent URL',
    description: 'Base URL used only for metrics ingestion through the vmagent durable queue.',
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
export type ControlPlaneConfigValue = z.infer<ControlPlaneConfigDefinition['schema']>;

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
