import { Link } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Badge } from '../components/ui/badge.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog.js';
import { toast } from '../hooks/use-toast.js';
import { Plus, Trash2, Settings2, ChevronRight, Image, Users, RefreshCw } from 'lucide-react';
import { Capability, GpuGrantMode } from '@nyabase/common';
import type { GroupDto, ServerDto, ImageDto, ServerGrantDto } from '@nyabase/common';
import { formatCpu, formatBytesCompact } from '../lib/utils.js';
import { queryKeys } from '../lib/query-keys.js';

const CAP_LABELS: Record<string, string> = {
  [Capability.ManageUsers]: '管理用户',
  [Capability.ManageGroups]: '管理用户组',
  [Capability.ManageServers]: '管理服务器',
  [Capability.ManageImages]: '管理镜像',
  [Capability.ManageGrants]: '管理授权',
  [Capability.ManageContainersAny]: '管理所有容器',
  [Capability.ViewAudit]: '查看审计',
  [Capability.ViewMetricsAll]: '查看全量监控',
  [Capability.ManageSystemSettings]: '管理系统设置',
};

const MEMBER_LIMIT = 30;
const IMAGE_CHIP_LIMIT = 5;

function gpuLabel(grant: ServerGrantDto): string {
  if (grant.gpuMode === null) return '显卡默认';
  if (grant.gpuMode === GpuGrantMode.None) return '无显卡';
  if (grant.gpuMode === GpuGrantMode.All) return '显卡全部';
  if (grant.gpuMode === GpuGrantMode.Indices) return `显卡[${(grant.gpuIndices ?? []).join(',')}]`;
  return '';
}

function ServerGrantChips({
  grants,
  serverMap,
}: {
  grants: ServerGrantDto[];
  serverMap: Map<string, string>;
}) {
  if (grants.length === 0) return <span className="text-xs text-muted-foreground/70">无服务器授权</span>;
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      {grants.map((g) => {
        const cpu = g.cpuMillis === null ? '不限' : formatCpu(g.cpuMillis);
        const mem = g.memBytes === null ? '不限' : formatBytesCompact(g.memBytes);
        const gpu = gpuLabel(g);
        const serverName = serverMap.get(g.serverId) ?? g.serverId.slice(0, 8);
        return (
          <div key={g.id} className="inline-flex flex-col px-2.5 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary min-w-0">
            <span className="text-xs font-medium leading-tight">{serverName}</span>
            <span className="text-[10px] text-primary/80 leading-tight mt-0.5 whitespace-nowrap">
              CPU {cpu} · 内存 {mem} · {gpu}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function GroupsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [editGroup, setEditGroup] = useState<GroupDto | null>(null);
  const qc = useQueryClient();

  const { data: groups = [], isFetching: groupsFetching, refetch: refetchGroups } = useQuery({
    queryKey: queryKeys.groups.admin, queryFn: () => api.get<GroupDto[]>('/admin/groups'),
  });
  const { data: servers = [] } = useQuery({
    queryKey: queryKeys.servers.admin, queryFn: () => api.get<ServerDto[]>('/admin/servers'),
  });
  const { data: images = [] } = useQuery({
    queryKey: queryKeys.images.admin, queryFn: () => api.get<ImageDto[]>('/admin/images'),
  });

  const serverMap = new Map(servers.map((s) => [s.id, s.name]));
  const imageMap = new Map(images.map((img) => [img.id, img.name]));

  const deleteGroup = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/groups/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.groups.admin }); toast({ title: '用户组已删除' }); },
    onError: (e) => toast({ title: '删除失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">用户组管理</h1>
          <p className="text-sm text-muted-foreground mt-0.5">通过用户组统一分配服务器/镜像权限</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetchGroups()} disabled={groupsFetching}>
            <RefreshCw className={`h-4 w-4 ${groupsFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />新建用户组
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {groups.map((g) => {
          const members = g.members ?? [];
          const visibleMembers = members.slice(0, MEMBER_LIMIT);
          const extraMembers = members.length - MEMBER_LIMIT;
          const imageIds = g.imageIds ?? [];
          const visibleImageIds = imageIds.slice(0, IMAGE_CHIP_LIMIT);
          const extraImages = imageIds.length - IMAGE_CHIP_LIMIT;

          return (
            <div key={g.id} className="bg-card rounded-lg border border-border p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 space-y-2.5">
                  {/* Header row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-foreground">{g.name}</span>
                    {g.isSystem && <Badge variant="outline" className="text-xs">系统组</Badge>}
                    <span className="text-xs text-muted-foreground/70">优先级 {g.priority}</span>
                  </div>

                  {g.description && <p className="text-sm text-muted-foreground">{g.description}</p>}

                  {/* Capability badges */}
                  {g.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {g.capabilities.map((cap) => (
                        <Badge key={cap} variant="secondary" className="text-xs">
                          {CAP_LABELS[cap] ?? cap}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Members */}
                  <div className="pt-1.5 border-t border-border">
                    <div className="flex items-center gap-1 mb-1.5">
                      <Users className="h-3 w-3 text-muted-foreground/70 shrink-0" />
                      <span className="text-xs text-muted-foreground/70">成员 {members.length}</span>
                    </div>
                    {members.length === 0 ? (
                      <span className="text-xs text-muted-foreground/70">暂无成员</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        {visibleMembers.map((m) => (
                          <span key={m.userId}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-foreground/90">
                            {m.username}
                          </span>
                        ))}
                        {extraMembers > 0 && (
                          <Link to="/groups/$id" params={{ id: g.id }}>
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted/50 text-muted-foreground/70 border border-border hover:bg-muted cursor-pointer">
                              +{extraMembers} 更多
                            </span>
                          </Link>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Server grants with resource details */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1 mb-1">
                      <span className="text-xs text-muted-foreground/70">服务器授权</span>
                    </div>
                    <ServerGrantChips grants={g.serverGrants ?? []} serverMap={serverMap} />
                  </div>

                  {/* Image grants */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1 mb-1">
                      <Image className="h-3 w-3 text-muted-foreground/70 shrink-0" />
                      <span className="text-xs text-muted-foreground/70">镜像授权</span>
                    </div>
                    {imageIds.length === 0 ? (
                      <span className="text-xs text-muted-foreground/70">无镜像授权</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        {visibleImageIds.map((id) => (
                          <span key={id}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-violet-50 text-violet-700 border border-violet-100">
                            {imageMap.get(id) ?? id.slice(0, 8)}
                          </span>
                        ))}
                        {extraImages > 0 && (
                          <span className="text-xs text-muted-foreground/70">+{extraImages}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="outline"
                    onClick={() => setEditGroup(g)}>
                    <Settings2 className="h-4 w-4" />编辑
                  </Button>
                  <Link to="/groups/$id" params={{ id: g.id }}>
                    <Button size="sm" variant="outline">
                      授权 <ChevronRight className="h-4 w-4" />
                    </Button>
                  </Link>
                  {!g.isSystem && (
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-600"
                      onClick={() => { if (confirm(`删除用户组 "${g.name}"？`)) deleteGroup.mutate(g.id); }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <CreateGroupDialog open={showCreate} onOpenChange={setShowCreate} />
      {editGroup && <EditGroupDialog group={editGroup} onClose={() => setEditGroup(null)} />}
    </div>
  );
}

function CreateGroupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', description: '', priority: '10', capabilities: [] as Capability[] });

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.post('/admin/groups', {
      name: form.name,
      description: form.description || undefined,
      priority: parseInt(form.priority) || 10,
      capabilities: form.capabilities,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.groups.admin });
      toast({ title: '用户组已创建' });
      onOpenChange(false);
      setForm({ name: '', description: '', priority: '10', capabilities: [] });
    },
    onError: (e) => toast({ title: '创建失败', description: e.message, variant: 'destructive' }),
  });

  const toggleCap = (cap: Capability) => setForm((f) => ({
    ...f,
    capabilities: f.capabilities.includes(cap)
      ? f.capabilities.filter((c) => c !== cap)
      : [...f.capabilities, cap],
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>新建用户组</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">组名</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">优先级（越大越强）</Label>
              <Input type="number" value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">描述（可选）</Label>
            <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">管理权限</Label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(CAP_LABELS).map(([cap, label]) => (
                <label key={cap} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.capabilities.includes(cap as Capability)}
                    onChange={() => toggleCap(cap as Capability)} className="rounded" />
                  <span className="text-sm text-foreground/90">{label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mutate()} disabled={isPending || !form.name}>
            {isPending ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditGroupDialog({ group, onClose }: { group: GroupDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: group.name,
    description: group.description ?? '',
    priority: String(group.priority),
    capabilities: [...group.capabilities],
  });

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.patch(`/admin/groups/${group.id}`, {
      name: form.name,
      description: form.description || null,
      priority: parseInt(form.priority) || 0,
      capabilities: form.capabilities,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.groups.admin });
      toast({ title: '用户组已更新' });
      onClose();
    },
    onError: (e) => toast({ title: '更新失败', description: e.message, variant: 'destructive' }),
  });

  const toggleCap = (cap: Capability) => setForm((f) => ({
    ...f,
    capabilities: f.capabilities.includes(cap)
      ? f.capabilities.filter((c) => c !== cap)
      : [...f.capabilities, cap],
  }));

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>编辑用户组：{group.name}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">组名</Label>
              <Input value={form.name} disabled={group.isSystem}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">优先级</Label>
              <Input type="number" value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">描述</Label>
            <Input value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">管理权限</Label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(CAP_LABELS).map(([cap, label]) => (
                <label key={cap} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.capabilities.includes(cap as Capability)}
                    onChange={() => toggleCap(cap as Capability)} className="rounded" />
                  <span className="text-sm text-foreground/90">{label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => mutate()} disabled={isPending}>
            {isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
