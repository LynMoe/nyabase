import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, RefreshCw, Server, Wifi, WifiOff } from 'lucide-react';
import {
  NodeMetricsStatus,
  zCreateServerRequest,
  zNodeMetricsCreateConfig,
  type CreateServerRequest,
  type ServerDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Badge } from '../components/ui/badge.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import {
  nodeMetricsStatusZh,
  preflightCheckLabel,
  preflightStatusLabel,
  serverStatusLabel,
} from '../lib/display-labels.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import { relativeTime } from '../lib/utils.js';

export default function ServersPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/admin/servers'),
  });
  const servers = serversQuery.data ?? [];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.admin });
  };

  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="server-onboarding-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">服务器</h1>
          <p className="text-sm text-muted-foreground">注册 Incus endpoint，完成互信、前置检查与存储池登记。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={refresh} disabled={serversQuery.isFetching} aria-label="刷新服务器">
            <RefreshCw className={serversQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
          <Button onClick={() => setOnboardingOpen(true)}>
            <Plus className="h-4 w-4" />添加服务器
          </Button>
        </div>
      </div>

      {serversQuery.isLoading ? (
        <QueryLoadingState label="加载服务器..." />
      ) : serversQuery.isError ? (
        <QueryErrorState error={serversQuery.error} resourceName="服务器目录" onRetry={() => { void serversQuery.refetch(); }} />
      ) : servers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Server className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">还没有注册服务器。</p>
            <Button onClick={() => setOnboardingOpen(true)}><Plus className="h-4 w-4" />开始接入</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {servers.map((server) => <ServerCard key={server.id} server={server} />)}
        </div>
      )}

      <ServerOnboardingDialog
        open={onboardingOpen}
        onOpenChange={setOnboardingOpen}
        onCreated={(serverId) => {
          refresh();
          setOnboardingOpen(false);
          void navigate({ to: '/servers/$id', params: { id: serverId } });
        }}
      />
    </div>
  );
}

function ServerCard({ server }: { server: ServerDto }) {
  const online = server.status === 'online';
  const capacity = server.preflightReport?.checks.storagePool === 'pass' ? '存储检查通过' : '等待前置检查';
  return (
    <Link to="/servers/$id" params={{ id: server.id }}>
      <Card className="h-full transition-colors hover:bg-accent/50">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="truncate text-base">{server.name}</CardTitle>
              <CardDescription className="mt-1 truncate font-mono">{server.slug}</CardDescription>
            </div>
            <Badge variant={online ? 'success' : 'secondary'}>
              {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {serverStatusLabel(server.status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">Incus</span><span>{server.incusVersion ?? '未连接'}</span></div>
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">系统盘池</span><span className={server.systemPoolName ? '' : 'font-mono text-xs'}>{server.systemPoolName ?? server.systemPoolId ?? '未指定'}</span></div>
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">前置检查</span><span>{preflightStatusLabel(server.preflightStatus)}</span></div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">指标</span>
            <span>{nodeMetricsStatusLabel(server.nodeMetrics.health.status)}</span>
          </div>
          {server.nodeMetrics.health.outageSince && (
            <p className="text-xs text-destructive">
              数据中断自 {new Date(server.nodeMetrics.health.outageSince).toLocaleString()}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{capacity} · 最近观测 {relativeTime(server.lastSeenAt)}</p>
          {server.preflightReport?.checks && (
            <div className="flex flex-wrap gap-1 pt-1">
              {Object.entries(server.preflightReport.checks).slice(0, 5).map(([name, result]) => (
                <Badge key={name} variant={result === 'pass' ? 'success' : result === 'warn' ? 'warning' : 'destructive'}>
                  {preflightCheckLabel(name)}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

type OnboardingForm = {
  name: string;
  slug: string;
  apiEndpoint: string;
  parentInterface: string;
  dnsServers: string;
  nodeMetricsEndpoint: string;
  nodeMetricsCertFingerprint: string;
  nodeMetricsToken: string;
};

const emptyOnboardingForm: OnboardingForm = {
  name: '',
  slug: '',
  apiEndpoint: 'https://',
  parentInterface: 'eth0',
  dnsServers: '',
  nodeMetricsEndpoint: '',
  nodeMetricsCertFingerprint: '',
  nodeMetricsToken: '',
};

function ServerOnboardingDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (serverId: string) => void;
}) {
  const [form, setForm] = useState<OnboardingForm>(emptyOnboardingForm);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateServerRequest) => api.post<ServerDto>('/admin/servers', body),
    onSuccess: (server) => {
      toast({ title: '服务器已登记', description: '请继续完成互信、存储池与前置检查。' });
      setForm(emptyOnboardingForm);
      setError(null);
      onCreated(server.id);
    },
    onError: (mutationError) => setError(mutationError instanceof Error ? mutationError.message : '服务器登记失败'),
  });

  useEffect(() => {
    if (!open) {
      setForm(emptyOnboardingForm);
      setError(null);
    }
  }, [open]);

  const update = (key: keyof OnboardingForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const submit = () => {
    const input = {
      name: form.name,
      slug: form.slug,
      apiEndpoint: form.apiEndpoint,
      parentInterface: form.parentInterface,
      dnsServers: splitList(form.dnsServers),
    } satisfies Omit<CreateServerRequest, 'nodeMetrics'>;
    const hasNodeMetricsInput = [
      form.nodeMetricsEndpoint,
      form.nodeMetricsCertFingerprint,
      form.nodeMetricsToken,
    ].some((value) => value.trim().length > 0);
    const nodeMetrics = hasNodeMetricsInput
      ? zNodeMetricsCreateConfig.safeParse({
          endpoint: form.nodeMetricsEndpoint.trim(),
          serverCertFingerprint: form.nodeMetricsCertFingerprint.trim(),
          token: form.nodeMetricsToken.trim(),
        })
      : null;
    if (hasNodeMetricsInput && !nodeMetrics?.success) {
      setError(nodeMetrics?.error.issues[0]?.message ?? '请完整填写 node-exporter 配置');
      return;
    }
    const request: CreateServerRequest = {
      ...input,
      ...(nodeMetrics?.success ? { nodeMetrics: nodeMetrics.data } : {}),
    };
    const parsed = zCreateServerRequest.safeParse(request);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查服务器参数');
      return;
    }
    create.mutate(parsed.data);
  };

  const fields: Array<[keyof OnboardingForm, string, string]> = [
    ['name', '显示名称', 'prod-incus-1'],
    ['slug', '标识', 'prod-incus-1'],
    ['apiEndpoint', 'Incus HTTPS endpoint', 'https://incus.example:8443'],
    ['parentInterface', '父接口', 'eth0'],
    ['dnsServers', 'DNS（逗号分隔）', '1.1.1.1,8.8.8.8'],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="server-onboarding">
        <DialogHeader>
          <DialogTitle>服务器接入</DialogTitle>
          <DialogDescription>登记连接参数后，在详情页粘贴 trust token 并执行前置检查。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map(([key, label, placeholder]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`server-onboarding-${key}`}>{label}</Label>
              <Input
                id={`server-onboarding-${key}`}
                value={form[key]}
                placeholder={placeholder}
                className={key === 'apiEndpoint' || key === 'slug' ? 'font-mono' : undefined}
                onChange={(event) => update(key, event.target.value)}
              />
            </div>
          ))}
        </div>
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <div>
            <p className="text-sm font-medium">node-exporter 指标（可选）</p>
            <p className="text-xs text-muted-foreground">token 只写入服务端，不会回显；留空表示稍后在详情页配置。</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="server-onboarding-node-metrics-endpoint">指标 endpoint</Label>
              <Input
                id="server-onboarding-node-metrics-endpoint"
                value={form.nodeMetricsEndpoint}
                placeholder="https://node.example:9100/metrics"
                className="font-mono"
                onChange={(event) => update('nodeMetricsEndpoint', event.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="server-onboarding-node-metrics-cert">证书 pin（SHA-256）</Label>
              <Input
                id="server-onboarding-node-metrics-cert"
                value={form.nodeMetricsCertFingerprint}
                placeholder="64 位十六进制指纹"
                className="font-mono"
                onChange={(event) => update('nodeMetricsCertFingerprint', event.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="server-onboarding-node-metrics-token">Bearer token</Label>
              <Input
                id="server-onboarding-node-metrics-token"
                type="password"
                autoComplete="new-password"
                value={form.nodeMetricsToken}
                placeholder="至少 32 个字符"
                onChange={(event) => update('nodeMetricsToken', event.target.value)}
              />
            </div>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={create.isPending}>{create.isPending ? '登记中...' : '登记服务器'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

function nodeMetricsStatusLabel(status: NodeMetricsStatus): string {
  return nodeMetricsStatusZh(status);
}
