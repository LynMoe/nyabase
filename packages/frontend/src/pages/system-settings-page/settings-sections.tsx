import type { SystemSettingFieldDto, SystemSettingsDto } from '@nyabase/common';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Switch } from '../../components/ui/switch.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import {
  createRevisionedServerBackedDraft,
  editRevisionedServerBackedDraft,
  mergeAuthoritativeRevisionedServerBackedDraft,
  mergeRevisionedServerBackedDraft,
  resolveRevisionedDraftConflicts,
  type RevisionedServerBackedDraft,
} from '../../lib/server-backed-draft.js';
import { api, ApiError, apiErrorCurrent } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { toast } from '../../hooks/use-toast.js';
import { parseSystemSettingDraft } from '../../lib/system-setting-draft.js';
import { isSystemSettingsDto } from '../../lib/conflict-snapshots.js';
import { queryKeys } from '../../lib/query-keys.js';

function sourceBadgeVariant(source: SystemSettingFieldDto['source']) {
  return source === 'env' ? 'warning' : source === 'yaml' ? 'secondary' : 'outline';
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
      <Switch
        id={`setting-${field.key}`}
        checked={value === 'true'}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
      />
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

/** The editable settings form, with the banner offered when the server changed fields under local edits. */
export function EditableSettingsSection({ draft }: { draft: SettingsDraft }) {
  const { draftState, setDraftState, editableFields, parsedChanges } = draft;
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-foreground">配置修改</h2>
      {draft.hasConflicts && draftState && (
        <Alert>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>服务器同时修改了 {draftState.conflictFields.size} 个字段；本地输入已保留，请选择处理方式。</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setDraftState(resolveRevisionedDraftConflicts(draftState, 'use-server'))}>
                使用服务器值
              </Button>
              <Button size="sm" onClick={() => setDraftState(resolveRevisionedDraftConflicts(draftState, 'keep-local'))}>
                保留本地并覆盖
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <form
        id="system-settings-form"
        className="overflow-hidden rounded-lg border border-border bg-background"
        onSubmit={(event) => {
          event.preventDefault();
          draft.submit();
        }}
      >
        {editableFields.map((field) => (
          <div key={field.key} className="grid gap-3 border-t border-border p-4 first:border-t-0 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)] lg:items-start">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor={`setting-${field.key}`} className="text-sm font-medium">
                  {fieldLabel(field)}
                </Label>
                <Badge variant={sourceBadgeVariant(field.source)}>
                  {SOURCE_LABELS[field.source]}
                </Badge>
                {draftState?.conflictFields.has(field.key) && <Badge variant="warning">服务器冲突</Badge>}
                {field.restartRequired && <Badge variant="outline">需要重启</Badge>}
              </div>
              <div className="mt-1">
                <TechnicalId label="配置路径" value={field.yamlPath} kind="text" />
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{fieldDescription(field)}</p>
            </div>
            <SettingInput
              field={field}
              value={draftState?.values[field.key] ?? ''}
              onChange={(value) => setDraftState((current) => current
                ? editRevisionedServerBackedDraft(current, field.key, value)
                : current)}
            />
            {parsedChanges.errors[field.key] && (
              <p className="text-xs text-destructive lg:col-start-2">{parsedChanges.errors[field.key]}</p>
            )}
          </div>
        ))}
      </form>
    </section>
  );
}

/** Every setting with its effective value and where that value came from. */
export function EffectiveSettingsSection({ fields }: { fields: SystemSettingFieldDto[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-foreground">有效配置</h2>
      <div className="space-y-4">
        {groupFields(fields).map((group) => (
          <div key={group.key} className="overflow-hidden rounded-lg border border-border bg-background">
            <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">{group.key}.*</p>
              </div>
              <Badge variant="outline">{group.fields.length} 项</Badge>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead>配置项</TableHead>
                  <TableHead>有效值</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>配置文件值</TableHead>
                  <TableHead>环境变量</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.fields.map((field) => (
                  <TableRow key={field.key}>
                    <TableCell>
                      <div className="font-mono text-xs text-foreground">{field.key}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{fieldLabel(field)}</span>
                        {field.restartRequired && <Badge variant="outline">需要重启</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="break-all">{displayValue(field, field.effectiveValue)}</TableCell>
                    <TableCell>
                      <Badge variant={sourceBadgeVariant(field.source)}>
                        {SOURCE_LABELS[field.source]}
                      </Badge>
                    </TableCell>
                    <TableCell className="break-all text-muted-foreground">{displayValue(field, field.yamlValue)}</TableCell>
                    <TableCell className="break-all text-muted-foreground">{field.envValuePresent ? field.env : '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      </div>
    </section>
  );
}

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
  containers: '容器统一限制',
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
    description: '会话空闲超时：在此天数内未刷新的登录会话失效；每次刷新顺延，但不超过会话最长有效期。',
  },
  'auth.sessionMaxLifetimeDays': {
    label: '会话最长有效天数',
    description: '从登录起算的登录会话绝对有效期，刷新不会延长；到期后需重新登录。',
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
  'ssh.proxyHostSuffix': {
    label: '容器主机名后缀',
    description: '用户通过 SSH 代理用 <容器名>.<后缀> 登录容器，容器主机证书也签发给这个名字。修改后用户已复制的 ssh_config 和 known_hosts 需要更新。',
  },
  'containers.processLimit': {
    label: '进程数上限',
    description: '每个容器可同时存在的进程与线程总数（limits.processes），对所有容器统一生效。',
  },
  'containers.networkIngressMbit': {
    label: '入站带宽上限（Mbit/s）',
    description: '每个容器网卡的入站带宽上限（limits.ingress）。',
  },
  'containers.networkEgressMbit': {
    label: '出站带宽上限（Mbit/s）',
    description: '每个容器网卡的出站带宽上限（limits.egress）。',
  },
  'containers.diskReadMBps': {
    label: '磁盘读速率上限（MB/s）',
    description: '系统盘与本地数据卷每块盘的读速率上限（limits.read）；CephFS 等网络文件系统无法限速。',
  },
  'containers.diskWriteMBps': {
    label: '磁盘写速率上限（MB/s）',
    description: '系统盘与本地数据卷每块盘的写速率上限（limits.write）；CephFS 等网络文件系统无法限速。',
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

type Draft = RevisionedServerBackedDraft<Record<string, string>>;

/** The editable (restart-free) settings as the strings the form inputs hold. */
function editableInputs(settings: SystemSettingsDto): Record<string, string> {
  return Object.fromEntries(
    settings.editable
      .filter((field) => !field.restartRequired)
      .map((field) => [field.key, editableInputValue(field)]),
  );
}

/**
 * The local draft of the system settings. It follows the server's revision:
 * refreshes keep local edits and flag fields the server changed too, and a
 * revision conflict on save merges the authoritative snapshot the same way.
 */
export function useSettingsDraft(settingsQuery: UseQueryResult<SystemSettingsDto>) {
  const qc = useQueryClient();
  const data = settingsQuery.data;
  const [draftState, setDraftState] = useState<Draft | null>(null);
  const editableFields = useMemo(
    () => (data?.editable ?? []).filter((field) => !field.restartRequired),
    [data?.editable],
  );

  useEffect(() => {
    if (!data) return;
    const incoming = Object.fromEntries(editableFields.map((field) => [field.key, editableInputValue(field)]));
    setDraftState((current) => current
      ? mergeRevisionedServerBackedDraft(current, incoming, data.revision)
      : createRevisionedServerBackedDraft(incoming, data.revision));
  }, [data, editableFields]);

  const parsedChanges = useMemo(() => {
    const values: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    if (!data) return { values, errors };
    for (const field of editableFields) {
      if (!draftState?.dirtyFields.has(field.key)) continue;
      const current = draftState.values[field.key];
      if (current === undefined) continue;
      const parsed = parseSystemSettingDraft(field, current);
      if (parsed.success) values[field.key] = parsed.value;
      else errors[field.key] = parsed.error;
    }
    return { values, errors };
  }, [data, draftState, editableFields]);

  const saveSettings = useMutation({
    mutationFn: ({ values, expectedRevision }: {
      values: Record<string, unknown>;
      expectedRevision: number;
    }) => api.patch<SystemSettingsDto>('/admin/system-settings', {
      values,
      expectedRevision,
    }),
    onSuccess: (updated) => {
      qc.setQueryData(queryKeys.systemSettings, updated);
      setDraftState(createRevisionedServerBackedDraft(editableInputs(updated), updated.revision));
      qc.invalidateQueries({ queryKey: queryKeys.publicSettings });
      toast({ title: '系统设置已保存' });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === 'SYSTEM_SETTINGS_REVISION_CONFLICT') {
        const current = apiErrorCurrent(
          error,
          'SYSTEM_SETTINGS_REVISION_CONFLICT',
          isSystemSettingsDto,
        );
        if (current) {
          qc.setQueryData(queryKeys.systemSettings, current);
          const incoming = editableInputs(current);
          setDraftState((draft) => draft
            ? mergeAuthoritativeRevisionedServerBackedDraft(draft, incoming, current.revision)
            : createRevisionedServerBackedDraft(incoming, current.revision));
        } else {
          await qc.refetchQueries({ queryKey: queryKeys.systemSettings, type: 'active' });
        }
      }
      toast({
        title: error instanceof ApiError && error.code === 'SYSTEM_SETTINGS_REVISION_CONFLICT'
          ? '服务器设置已变化'
          : '保存失败',
        description: errorMessage(error, '请检查配置值'),
        variant: 'destructive',
      });
    },
  });

  const hasChanges = Object.keys(parsedChanges.values).length > 0;
  const hasValidationErrors = Object.keys(parsedChanges.errors).length > 0;
  const hasConflicts = (draftState?.conflictFields.size ?? 0) > 0;
  const canSave = hasChanges && !hasValidationErrors && !hasConflicts && !saveSettings.isPending;

  return {
    draftState,
    setDraftState,
    editableFields,
    parsedChanges,
    saveSettings,
    hasConflicts,
    canSave,
    /** Save the changed fields against the revision the draft is based on. */
    submit: () => {
      if (data && draftState && canSave) {
        saveSettings.mutate({
          values: parsedChanges.values,
          expectedRevision: draftState.revision,
        });
      }
    },
  };
}

export type SettingsDraft = ReturnType<typeof useSettingsDraft>;
