import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Save } from 'lucide-react';
import {
  type SystemSettingFieldDto,
  type SystemSettingsDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Badge } from '../components/ui/badge.js';
import { toast } from '../hooks/use-toast.js';

const SOURCE_LABELS = {
  default: '默认值',
  yaml: 'config.yaml',
  env: '环境变量',
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
  'auth.refreshTokenExpiresDays': {
    label: '刷新令牌有效天数',
    description: '刷新令牌过期前可使用的天数。',
  },
  'auth.adminInitPassword': {
    label: '初始管理员密码',
    description: '仅用于初始化第一个管理员账号的密码。',
  },
  'database.driver': {
    label: '数据库驱动',
    description: 'TypeORM 使用 SQLite 数据库驱动。',
  },
  'database.path': {
    label: 'SQLite 文件路径',
    description: 'SQLite 数据库文件路径。',
  },
  'database.synchronize': {
    label: '数据库同步',
    description: '允许在非生产环境启用 TypeORM synchronize。',
  },
  'database.migrationsRun': {
    label: '启动时执行迁移',
    description: '启动时自动执行待运行的 TypeORM 迁移。',
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
    description: '指标读写使用的基础地址。',
  },
  'http.proxyToken': {
    label: 'HTTP 代理令牌',
    description: 'HTTP 代理进程连接后端时使用的 Bearer 令牌。',
  },
  'ssh.keyEncryptionSecret': {
    label: 'SSH 密钥加密密钥',
    description: '用于加密数据库中内部 SSH 密钥的密钥。',
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

function fieldLabel(field: SystemSettingFieldDto): string {
  return FIELD_LABELS[field.key]?.label ?? field.label;
}

function fieldDescription(field: SystemSettingFieldDto): string {
  return FIELD_LABELS[field.key]?.description ?? field.description;
}

function displayValue(field: SystemSettingFieldDto, value: unknown): string {
  if (field.secret && value) return '********';
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function editableInputValue(field: SystemSettingFieldDto): string {
  const value = field.yamlValue ?? field.effectiveValue ?? field.defaultValue;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value === undefined || value === null ? '' : String(value);
}

function parseEditableValue(field: SystemSettingFieldDto, value: string): unknown {
  if (field.valueKind === 'number') return Number(value);
  if (field.valueKind === 'boolean') return value === 'true';
  return value;
}

function groupFields(fields: SystemSettingFieldDto[]): Array<{
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

export default function SystemSettingsPage() {
  const qc = useQueryClient();
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => api.get<SystemSettingsDto>('/admin/system-settings'),
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const editableFields = useMemo(
    () => (data?.editable ?? []).filter((field) => !field.restartRequired),
    [data?.editable],
  );

  useEffect(() => {
    if (!data) return;
    setDraft(Object.fromEntries(editableFields.map((field) => [field.key, editableInputValue(field)])));
  }, [data, editableFields]);

  const changedValues = useMemo(() => {
    if (!data) return {};
    const values: Record<string, unknown> = {};
    for (const field of editableFields) {
      const current = draft[field.key];
      if (current === undefined) continue;
      if (current !== editableInputValue(field)) {
        values[field.key] = parseEditableValue(field, current);
      }
    }
    return values;
  }, [data, draft, editableFields]);

  const saveSettings = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.patch<SystemSettingsDto>('/admin/system-settings', { values }),
    onSuccess: (updated) => {
      qc.setQueryData(['system-settings'], updated);
      qc.invalidateQueries({ queryKey: ['public-settings'] });
      toast({ title: '系统设置已保存' });
    },
    onError: (error) => toast({
      title: '保存失败',
      description: error instanceof Error ? error.message : '请检查配置值',
      variant: 'destructive',
    }),
  });

  const hasChanges = Object.keys(changedValues).length > 0;
  const effectiveGroups = useMemo(() => groupFields(data?.fields ?? []), [data?.fields]);

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">系统设置</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data?.configFile ?? '/etc/nyabase/config.yaml'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button type="submit" form="system-settings-form" disabled={!hasChanges || saveSettings.isPending}>
            <Save className="h-4 w-4" />
            保存
          </Button>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">配置修改</h2>
        <form
          id="system-settings-form"
          className="overflow-hidden rounded-lg border border-border bg-background"
          onSubmit={(event) => {
            event.preventDefault();
            if (hasChanges && !saveSettings.isPending) saveSettings.mutate(changedValues);
          }}
        >
          {editableFields.map((field) => (
            <div key={field.key} className="grid gap-3 border-t border-border p-4 first:border-t-0 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)] lg:items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor={`setting-${field.key}`} className="text-sm font-medium">
                    {fieldLabel(field)}
                  </Label>
                  <Badge variant={field.source === 'env' ? 'warning' : field.source === 'yaml' ? 'secondary' : 'outline'}>
                    {SOURCE_LABELS[field.source]}
                  </Badge>
                    {field.restartRequired && <Badge variant="outline">需要重启</Badge>}
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{field.yamlPath}</p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{fieldDescription(field)}</p>
              </div>
              <SettingInput
                field={field}
                value={draft[field.key] ?? ''}
                onChange={(value) => setDraft((prev) => ({ ...prev, [field.key]: value }))}
              />
            </div>
          ))}
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">有效配置</h2>
        <div className="space-y-4">
          {effectiveGroups.map((group) => (
            <div key={group.key} className="overflow-hidden rounded-lg border border-border bg-background">
              <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">{group.key}.*</p>
                </div>
                <Badge variant="outline">{group.fields.length} 项</Badge>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">配置项</th>
                    <th className="text-left font-medium px-3 py-2">有效值</th>
                    <th className="text-left font-medium px-3 py-2">来源</th>
                    <th className="text-left font-medium px-3 py-2">配置文件值</th>
                    <th className="text-left font-medium px-3 py-2">环境变量</th>
                  </tr>
                </thead>
                <tbody>
                  {group.fields.map((field) => (
                    <tr key={field.key} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-mono text-xs text-foreground">{field.key}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{fieldLabel(field)}</span>
                          {field.restartRequired && <Badge variant="outline">需要重启</Badge>}
                        </div>
                      </td>
                      <td className="px-3 py-2 break-all">{displayValue(field, field.effectiveValue)}</td>
                      <td className="px-3 py-2">
                        <Badge variant={field.source === 'env' ? 'warning' : field.source === 'yaml' ? 'secondary' : 'outline'}>
                          {SOURCE_LABELS[field.source]}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 break-all text-muted-foreground">{displayValue(field, field.yamlValue)}</td>
                      <td className="px-3 py-2 break-all text-muted-foreground">{field.envValuePresent ? field.env : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SettingInput({
  field,
  value,
  onChange,
}: {
  field: SystemSettingFieldDto;
  value: string;
  onChange: (value: string) => void;
}) {
  const disabled = field.source === 'env';
  if (field.valueKind === 'boolean') {
    return (
      <select
        id={`setting-${field.key}`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  }
  return (
    <Input
      id={`setting-${field.key}`}
      value={value}
      type={field.valueKind === 'number' ? 'number' : 'text'}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
