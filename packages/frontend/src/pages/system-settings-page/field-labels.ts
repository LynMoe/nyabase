import type { SystemSettingFieldDto } from '@nyabase/common';

export const SOURCE_LABELS = {
  default: '默认值',
  yaml: 'config.yaml',
  env: '环境变量',
  database: 'PostgreSQL',
} as const;

const GROUP_LABELS: Record<string, string> = {
  runtime: '运行时',
  server: '服务',
  branding: '品牌',
  auth: '认证',
  database: '数据库',
  audit: '审计',
  metrics: '监控',
  ssh: 'SSH 代理',
};

const FIELD_LABELS: Record<string, { label: string; description: string }> = {
  'runtime.nodeEnv': {
    label: 'Node 运行环境',
    description: '用于生产环境安全检查的运行环境。',
  },
  'server.port': {
    label: 'HTTP 端口',
    description: '后端 HTTP 服务监听端口。',
  },
  'server.corsOrigin': {
    label: '跨域来源',
    description: '当前端独立部署时允许访问后端 API 的浏览器来源。',
  },
  'branding.title': {
    label: '产品标题',
    description: '登录页和侧边栏显示的产品名称。',
  },
  'branding.description': {
    label: '产品描述',
    description: '登录页显示的简短说明。',
  },
  'auth.jwtSecret': {
    label: 'JWT 密钥',
    description: '用于签发浏览器和 API JWT 的密钥。',
  },
  'auth.jwtExpiresIn': {
    label: 'JWT 有效期',
    description: '访问令牌传给 JWT 签发器的有效时间。',
  },
  'auth.sessionHours': {
    label: '会话时长',
    description: '登录会话在无操作后保持有效的小时数。',
  },
  'auth.refreshTokenExpiresDays': {
    label: '刷新令牌有效天数',
    description: '刷新令牌过期前可使用的天数。',
  },
  'auth.adminInitPassword': {
    label: '初始管理员密码',
    description: '仅用于初始化第一个管理员账号的密码。',
  },
  'database.url': {
    label: 'PostgreSQL 连接地址',
    description: '控制面唯一事实源的 PostgreSQL 连接地址。',
  },
  'database.poolMax': {
    label: '最大连接池',
    description: '当前进程最多使用的 PostgreSQL 连接数。',
  },
  'database.idleTimeoutMs': {
    label: '空闲连接超时',
    description: 'PostgreSQL 空闲连接关闭前的毫秒数。',
  },
  'database.statementTimeoutMs': {
    label: 'SQL 执行超时',
    description: 'PostgreSQL 语句允许执行的最长毫秒数。',
  },
  'database.migrationsRun': {
    label: '启动时执行迁移',
    description: '持有 PostgreSQL advisory lock 时执行待运行的 SQL migration。',
  },
  'audit.retentionDays': {
    label: '审计保留天数',
    description: '审计日志保留天数；设为 0 表示不按时间清理。',
  },
  'audit.retentionMaxEntries': {
    label: '审计最大条数',
    description: '最多保留的审计日志条数；设为 0 表示不按数量清理。',
  },
  'metrics.victoriaMetricsUrl': {
    label: 'VictoriaMetrics 地址',
    description: '指标写入和查询使用的 VictoriaMetrics 地址。',
  },
  'ssh.enabled': {
    label: '启用 SSH 代理',
    description: '关闭后用户无法通过平台 SSH 代理 Jump 到容器。',
  },
  'ssh.keyEncryptionSecret': {
    label: '密钥加密密钥',
    description: '用于加密 SSH 代理主机密钥和 HTTP 代理 TLS 材料。',
  },
  'ssh.proxyToken': {
    label: 'SSH 代理令牌',
    description: 'SSH 代理进程连接后端时使用的 Bearer 令牌。',
  },
  'ssh.proxyPublicHost': {
    label: 'SSH 代理公网主机',
    description: '用户通过 SSH 代理连接时使用的主机名。',
  },
  'ssh.proxyPublicPort': {
    label: 'SSH 代理公网端口',
    description: '用户通过 SSH 代理连接时使用的端口。',
  },
  'ssh.proxySnapshotStaleMs': {
    label: 'SSH 代理快照过期时间',
    description: 'SSH 代理状态快照被判定为过期前的毫秒数（120000–300000）。',
  },
};

export function fieldLabel(field: SystemSettingFieldDto): string {
  return FIELD_LABELS[field.key]?.label ?? field.label;
}

export function fieldDescription(field: SystemSettingFieldDto): string {
  return FIELD_LABELS[field.key]?.description ?? field.description;
}

export function displayValue(field: SystemSettingFieldDto, value: unknown): string {
  if (field.secret && value) return '********';
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

export function editableInputValue(field: SystemSettingFieldDto): string {
  const value = field.source === 'database'
    ? field.effectiveValue
    : field.yamlValue ?? field.effectiveValue ?? field.defaultValue;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value === undefined || value === null ? '' : String(value);
}

export function groupFields(fields: SystemSettingFieldDto[]): Array<{
  key: string;
  label: string;
  fields: SystemSettingFieldDto[];
}> {
  const groups = new Map<string, SystemSettingFieldDto[]>();
  for (const field of fields) {
    const groupKey = field.key.split('.')[0] ?? 'other';
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), field]);
  }
  return Array.from(groups.entries()).map(([key, groupedFields]) => ({
    key,
    label: GROUP_LABELS[key] ?? key,
    fields: groupedFields,
  }));
}
