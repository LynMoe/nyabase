import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Progress } from '../components/ui/progress.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog.js';
import { toast } from '../hooks/use-toast.js';
import { formatBytes, relativeTime } from '../lib/utils.js';
import { queryKeys } from '../lib/query-keys.js';
import { Plus, Server, RefreshCw } from 'lucide-react';
import { Capability } from '@nyabase/common';
import type { ServerDto } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';

export default function ServersPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const canManage = user?.capabilities.includes(Capability.ManageServers) ?? false;

  useEffect(() => {
    if (user && !canManage) {
      navigate({ to: '/', replace: true });
    }
  }, [user, canManage, navigate]);

  const [showCreate, setShowCreate] = useState(false);
  const { data: servers = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/admin/servers'),
    refetchInterval: 15_000,
  });

  if (!canManage) return null;

  return (
    <div className="p-6 space-y-4 w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">服务器</h1>
          <p className="text-muted-foreground text-sm">{servers.length} 台已注册</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />添加服务器
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => <Card key={i}><CardContent className="h-36 animate-pulse bg-muted/50 rounded-lg mt-6" /></Card>)}
        </div>
      ) : servers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 space-y-3">
            <Server className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">还没有服务器</p>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />添加服务器
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {servers.map((s) => <ServerCard key={s.id} server={s} />)}
        </div>
      )}

      <CreateServerDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  );
}

function ServerCard({ server: s }: { server: ServerDto }) {
  const online = s.status === 'online';
  const disks = s.disks ?? [];
  const gpus = s.gpus ?? [];
  const totalDisk = disks.reduce((a, d) => a + d.totalBytes, 0);
  const usedDisk = disks.reduce((a, d) => a + d.usedBytes, 0);
  const diskPct = totalDisk > 0 ? (usedDisk / totalDisk) * 100 : 0;

  return (
    <Link to="/servers/$id" params={{ id: s.id }}>
      <Card className="hover:bg-accent/50 transition-colors cursor-pointer h-full">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{s.name}</CardTitle>
            <Badge variant={online ? 'success' : 'secondary'}>{s.status}</Badge>
          </div>
          <CardDescription className="font-mono text-xs">{s.ipCidr}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {gpus.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {gpus.map((g) => (
                <Badge key={g.index} variant="secondary" className="text-xs">
                  GPU {g.index}: {g.model.replace('NVIDIA ', '')}
                </Badge>
              ))}
            </div>
          )}
          {totalDisk > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>磁盘</span>
                <span>{formatBytes(usedDisk)} / {formatBytes(totalDisk)}</span>
              </div>
              <Progress value={diskPct} className="h-2" />
            </div>
          )}
          <p className="text-xs text-muted-foreground">最近活跃 {relativeTime(s.lastSeenAt)}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

function CreateServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', parentIface: 'eth0', ipCidr: '', gateway: '' });
  const [isGpuServer, setIsGpuServer] = useState(true);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.post<{ server: ServerDto; agentToken: string }>('/admin/servers', { ...form, isGpuServer }),
    onSuccess: (res) => {
      setCreatedToken(res.agentToken);
      qc.invalidateQueries({ queryKey: queryKeys.servers.admin });
    },
    onError: (e) => toast({ title: '创建失败', description: e.message, variant: 'destructive' }),
  });

  const handleClose = () => { setCreatedToken(null); onOpenChange(false); };
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const fields: [keyof typeof form, string, string][] = [
    ['name', '服务器名称', 'prod-gpu-1'],
    ['parentIface', '物理网卡', 'eth0'],
    ['ipCidr', 'macvlan 网段 (CIDR)', '192.168.10.0/24'],
    ['gateway', '网关', '192.168.10.1'],
  ];

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加服务器</DialogTitle>
          <DialogDescription>添加后将生成 Agent Token，部署到服务器上的 agent 配置文件中。</DialogDescription>
        </DialogHeader>

        {createdToken ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              ⚠ Agent Token 仅显示一次，请立即复制并保存。
            </p>
            <div className="rounded-md bg-muted p-3">
              <code className="text-xs break-all">{createdToken}</code>
            </div>
            <Button
              variant="outline" className="w-full"
              onClick={() => navigator.clipboard.writeText(createdToken)}
            >
              复制 Token
            </Button>
            <Button className="w-full" onClick={handleClose}>完成</Button>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {fields.map(([k, lbl, ph]) => (
                <div key={k} className="space-y-1.5">
                  <Label>{lbl}</Label>
                  <Input placeholder={ph} value={form[k]} onChange={(e) => set(k, e.target.value)} />
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <input
                  id="create-is-gpu-server"
                  type="checkbox"
                  checked={isGpuServer}
                  onChange={(e) => setIsGpuServer(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <Label htmlFor="create-is-gpu-server" className="text-sm cursor-pointer">
                  GPU 服务器（启用 GPU 监控与配额）
                </Label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>取消</Button>
              <Button onClick={() => mutate()} disabled={isPending || !form.name || !form.ipCidr}>
                {isPending ? '创建中...' : '创建'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
