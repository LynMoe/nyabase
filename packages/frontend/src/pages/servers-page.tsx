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
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ResourceGrid } from '../components/layout/resource-grid.js';
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
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.admin });
  };

  return (
    <Page testId="server-onboarding-page">
      <PageHeader
        title="服务器"
        description="注册 Incus endpoint，完成互信、前置检查与存储池登记。"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={refresh} disabled={serversQuery.isFetching} aria-label="刷新服务器">
              <RefreshCw className={serversQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </Button>
            <Button onClick={() => setOnboardingOpen(true)}>
              <Plus className="h-4 w-4" />添加服务器
            </Button>
          </>
        }
      />
      <QueryView
        query={serversQuery}
        resourceName="服务器目录"
        loadingLabel="加载服务器..."
        showEmpty={serversQuery.data?.length === 0}
        empty={
          <EmptyState
            icon={Server}
            title="还没有注册服务器。"
            action={<Button onClick={() => setOnboardingOpen(true)}><Plus className="h-4 w-4" />开始接入</Button>}
          />
        }
      >
        {(items) => (
          <ResourceGrid>
            {items.map((server) => <ServerCard key={server.id} server={server} />)}
          </ResourceGrid>
        )}
      </QueryView>
      <ServerOnboardingDialog
        open={onboardingOpen}
        onOpenChange={setOnboardingOpen}
        onCreated={(serverId) => {
          refresh();
          setOnboardingOpen(false);
          void navigate({ to: '/servers/$id', params: { id: serverId } });
        }}
      />
    </Page>
  );
}

function ServerCard({ server }: { server: ServerDto }) {
  const online = server.status === 'online';
  const capacity = server.preflightStatus === 'passed'
    ? '前置检查已通过'
    : server.preflightReport?.checks.storagePool === 'pass'
      ? '存储检查通过'
      : '等待前置检查';
  return (
    <Link to="/servers/$id" params={{ id: server.id }}>
      <Card className="h-full transition-colors hover:bg-accent/50">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="truncate text-base">{server.name}</CardTitle>
              <CardDescription className="mt-1 truncate font-mono">
                {server.slug && server.slug !== server.name ? server.slug : server.apiEndpoint}
              </CardDescription>
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
    ['parentInterface', 'LAN 网桥 (vmbr)', 'vmbr0'],
    ['dnsServers', 'DNS（逗号分隔）', '1.1.1.1,8.8.8.8'],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="server-onboarding">
        <DialogHeader>
          <DialogTitle>服务器接入</DialogTitle>
          <DialogDescription>登记连接参数后，在详情页粘贴 trust token 并执行前置检查。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map(([key, label, placeholder]) => (
            <div
              key={key}
              className={key === 'name' || key === 'slug' ? 'space-y-1.5' : 'space-y-1.5 sm:col-span-2'}
            >
              <Label htmlFor={`server-onboarding-${key}`}>{label}</Label>
              <Input
                id={`server-onboarding-${key}`}
                value={form[key]}
                placeholder={placeholder}
                className={key === 'apiEndpoint' || key === 'slug' ? 'truncate font-mono' : undefined}
                onChange={(event) => update(key, event.target.value)}
              />
            </div>
          ))}
        </div>
        <details className="rounded-md border bg-muted/20 p-3">
          <summary className="cursor-pointer text-sm font-medium">node-exporter 指标（可选）</summary>
          <p className="mt-1 text-xs text-muted-foreground">token 只写入服务端，不会回显；留空表示稍后在详情页配置。</p>
          <div className="mt-3 grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="server-onboarding-node-metrics-endpoint">指标 endpoint</Label>
              <Input
                id="server-onboarding-node-metrics-endpoint"
                value={form.nodeMetricsEndpoint}
                placeholder="https://node.example:9100/metrics"
                className="truncate font-mono"
                onChange={(event) => update('nodeMetricsEndpoint', event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="server-onboarding-node-metrics-cert">证书 pin（SHA-256）</Label>
              <Input
                id="server-onboarding-node-metrics-cert"
                value={form.nodeMetricsCertFingerprint}
                placeholder="64 位十六进制指纹"
                className="truncate font-mono"
                onChange={(event) => update('nodeMetricsCertFingerprint', event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
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
        </details>
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
