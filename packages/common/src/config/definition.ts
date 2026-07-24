import { z } from 'zod';
import {
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
} from '../constants.js';

export const DEFAULT_NYABASE_CONFIG_FILE = '/etc/nyabase/config.yaml';

export type ConfigSourceName = 'default' | 'yaml' | 'env';
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
    key: 'database.driver',
    yamlPath: 'database.driver',
    env: 'DB_DRIVER',
    defaultValue: 'sqlite',
    schema: z.literal('sqlite'),
    valueKind: 'enum',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Database driver',
    description: 'SQLite-only TypeORM database driver.',
  }),
  field({
    key: 'database.path',
    yamlPath: 'database.path',
    env: 'DB_PATH',
    defaultValue: './nyabase.db',
    schema: nonEmptyString,
    valueKind: 'string',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'SQLite path',
    description: 'SQLite database file path.',
  }),
  field({
    key: 'database.synchronize',
    yamlPath: 'database.synchronize',
    env: 'DB_SYNC',
    defaultValue: true,
    schema: booleanLike,
    valueKind: 'boolean',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Database synchronize',
    description: 'Allows TypeORM synchronize outside production.',
  }),
  field({
    key: 'database.migrationsRun',
    yamlPath: 'database.migrationsRun',
    env: 'DB_MIGRATIONS_RUN',
    defaultValue: false,
    schema: booleanLike,
    valueKind: 'boolean',
    secret: false,
    editable: false,
    restartRequired: true,
    public: false,
    label: 'Run migrations',
    description: 'Runs pending TypeORM migrations on startup.',
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
    description: 'Base URL for metrics reads and writes.',
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
    description: 'Secret used to encrypt internal SSH keys stored in the database.',
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
    public: false,
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
    public: false,
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
