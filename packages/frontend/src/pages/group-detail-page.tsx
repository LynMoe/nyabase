import { Link, getRouteApi } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
import { toast } from '../hooks/use-toast.js';
import { ArrowLeft, Trash2, Plus } from 'lucide-react';
import { GpuGrantMode } from '@nyabase/common';
import type { GroupDto, GroupMemberDto, UserDto, ServerDto, ServerGrantDto, ImageDto, ImageGrantDto } from '@nyabase/common';
import { formatBytes, formatCpu, resourceVal } from '../lib/utils.js';
import {
  ResourceGrantForm, ResourceFormValue, EMPTY_RESOURCE_FORM,
  grantToForm, formToGrantPayload,
} from '../components/resource-grant-form.js';
import { MountSourceGrantsPanel } from '../components/grants/mount-source-grants-panel.js';
import { queryKeys } from '../lib/query-keys.js';

const routeApi = getRouteApi('/groups/$id');

export default function GroupDetailPage() {
  const { id } = routeApi.useParams();
  const [activeTab, setActiveTab] = useState<'members' | 'server-grants' | 'image-grants' | 'mount-source-grants'>('members');

  const { data: group } = useQuery({
    queryKey: ['group', id], queryFn: () => api.get<GroupDto>(`/admin/groups/${id}`),
  });

  if (!group) return <div className="px-4 py-4 md:px-6 text-muted-foreground">加载中...</div>;

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex items-center gap-3">
        <Link to="/groups">
          <Button variant="outline" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{group.name}</h1>
          <p className="text-sm text-muted-foreground">优先级 {group.priority} · {group.isSystem ? '系统组' : '自定义组'}</p>
        </div>
      </div>

      <div className="flex gap-2">
        {(['members', 'server-grants', 'image-grants', 'mount-source-grants'] as const).map((tab) => (
          <button key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm rounded-md font-medium transition-colors ${
              activeTab === tab ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}>
            {tab === 'members' ? '成员' : tab === 'server-grants' ? '服务器授权' : tab === 'image-grants' ? '镜像授权' : '数据源授权'}
          </button>
        ))}
      </div>

      {activeTab === 'members' && <GroupMembersTab groupId={id} />}
      {activeTab === 'server-grants' && <GroupServerGrantsTab groupId={id} />}
      {activeTab === 'image-grants' && <GroupImageGrantsTab groupId={id} />}
      {activeTab === 'mount-source-grants' && (
        <MountSourceGrantsPanel
          subject={{ type: 'group', id }}
          description="选择该用户组可以访问哪些数据源（仍需同时拥有对应服务器的访问权限）"
        />
      )}
    </div>
  );
}

function GroupMembersTab({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const [selectedUserId, setSelectedUserId] = useState('');

  const { data: members = [] } = useQuery({
    queryKey: ['group-members', groupId],
    queryFn: () => api.get<GroupMemberDto[]>(`/admin/groups/${groupId}/members`),
  });
  const { data: allUsers = [] } = useQuery({
    queryKey: queryKeys.users.admin, queryFn: () => api.get<UserDto[]>('/admin/users'),
  });

  const memberIds = new Set(members.map((m) => m.userId));
  const nonMembers = allUsers.filter((u) => !memberIds.has(u.id));

  const addMember = useMutation({
    mutationFn: (userId: string) => api.post(`/admin/groups/${groupId}/members`, { userId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['group-members', groupId] });
      toast({ title: '成员已添加' });
      setSelectedUserId('');
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete(`/admin/groups/${groupId}/members/${userId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['group-members', groupId] }); toast({ title: '成员已移出' }); },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {members.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center border border-dashed border-border rounded-lg">暂无成员</div>
        )}
        {members.map((m) => (
          <div key={m.userId} className="flex items-center justify-between py-2.5 px-4 rounded-lg border border-border bg-background">
            <div>
              <span className="font-mono text-sm font-medium text-foreground">{m.username}</span>
              {m.displayName && <span className="text-sm text-muted-foreground ml-2">{m.displayName}</span>}
            </div>
            <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-600"
              onClick={() => removeMember.mutate(m.userId)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {nonMembers.length > 0 && (
        <div className="flex gap-2 pt-2 border-t border-border">
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
          className="flex-1 text-sm border border-border rounded-lg px-3 py-1.5 bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
            <option value="">选择用户添加...</option>
            {nonMembers.map((u) => (
              <option key={u.id} value={u.id}>{u.username}{u.displayName ? ` (${u.displayName})` : ''}</option>
            ))}
          </select>
          <Button size="sm" className="shrink-0" disabled={!selectedUserId || addMember.isPending}
            onClick={() => selectedUserId && addMember.mutate(selectedUserId)}>
            <Plus className="h-4 w-4" />添加
          </Button>
        </div>
      )}
    </div>
  );
}

function GroupServerGrantsTab({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [form, setForm] = useState<ResourceFormValue>(EMPTY_RESOURCE_FORM);

  const { data: servers = [] } = useQuery({
    queryKey: queryKeys.servers.admin, queryFn: () => api.get<ServerDto[]>('/admin/servers'),
  });
  const { data: grants = [] } = useQuery({
    queryKey: ['group-server-grants', groupId],
    queryFn: () => api.get<ServerGrantDto[]>(`/admin/groups/${groupId}/server-grants`),
  });

  const getGrant = (sid: string) => grants.find((g) => g.serverId === sid);

  const upsert = useMutation({
    mutationFn: (serverId: string) => api.post(
      `/admin/groups/${groupId}/server-grants/${serverId}`,
      formToGrantPayload(form),
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['group-server-grants', groupId] });
      toast({ title: '授权已更新' });
      setEditingServerId(null);
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const remove = useMutation({
    mutationFn: (serverId: string) => api.delete(`/admin/groups/${groupId}/server-grants/${serverId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['group-server-grants', groupId] }); toast({ title: '授权已移除' }); },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const startEdit = (serverId: string) => {
    const g = getGrant(serverId);
    setForm(g ? grantToForm(g) : EMPTY_RESOURCE_FORM);
    setEditingServerId(serverId);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">空字段使用服务器的默认值（在服务器详情页设置）</p>
      {servers.map((s) => {
        const g = getGrant(s.id);
        if (editingServerId === s.id) {
          return (
            <div key={s.id} className="border rounded-lg p-4 space-y-3 bg-background">
              <div className="font-medium text-sm text-foreground">{s.name}</div>
              <ResourceGrantForm
                value={form}
                onChange={setForm}
                emptyHint="（空=服务器默认）"
                showGpu={s.isGpuServer}
                serverDefaults={{ cpuMillis: s.defaultCpuMillis, memBytes: s.defaultMemBytes, diskBytes: s.defaultDiskBytes }}
              />
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="outline" onClick={() => setEditingServerId(null)}>取消</Button>
                <Button size="sm" onClick={() => upsert.mutate(s.id)}>保存</Button>
              </div>
            </div>
          );
        }

        return (
          <div key={s.id} className="flex items-center justify-between py-3 px-4 rounded-lg border border-border bg-background">
            <div>
              <span className="font-medium text-foreground">{s.name}</span>
              <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${s.status === 'online' ? 'bg-green-50 text-green-700' : 'bg-muted text-muted-foreground'}`}>
                {s.status === 'online' ? '在线' : '离线'}
              </span>
              {g ? (
                <div className="text-xs mt-1 space-x-3">
                  <span className={g.cpuMillis === null ? 'text-muted-foreground/40' : 'text-muted-foreground'}>
                    {resourceVal(g.cpuMillis, s.defaultCpuMillis, formatCpu)} CPU
                  </span>
                  <span className={g.memBytes === null ? 'text-muted-foreground/40' : 'text-muted-foreground'}>
                    {resourceVal(g.memBytes, s.defaultMemBytes, formatBytes)} 内存
                  </span>
                  <span className={g.diskBytes === null ? 'text-muted-foreground/40' : 'text-muted-foreground'}>
                    {resourceVal(g.diskBytes, s.defaultDiskBytes, formatBytes)} 磁盘
                  </span>
                  {s.isGpuServer && (
                    <span className="text-muted-foreground">
                      GPU: {g.gpuMode ?? '服务器默认'}{g.gpuMode === GpuGrantMode.Indices ? ` [${g.gpuIndices?.join(',')}]` : ''}
                    </span>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground/50 mt-1">无授权</div>
              )}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => startEdit(s.id)}>
                {g ? '编辑' : <><Plus className="h-4 w-4" />授权</>}
              </Button>
              {g && (
                <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-600"
                  onClick={() => remove.mutate(s.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GroupImageGrantsTab({ groupId }: { groupId: string }) {
  const qc = useQueryClient();

  const { data: images = [] } = useQuery({
    queryKey: queryKeys.images.admin, queryFn: () => api.get<ImageDto[]>('/admin/images'),
  });
  const { data: servers = [] } = useQuery({
    queryKey: queryKeys.servers.admin, queryFn: () => api.get<ServerDto[]>('/admin/servers'),
  });
  const { data: grants = [] } = useQuery({
    queryKey: ['group-image-grants', groupId],
    queryFn: () => api.get<ImageGrantDto[]>(`/admin/groups/${groupId}/image-grants`),
  });

  const syncServers = useMutation({
    mutationFn: ({ imageId, serverIds }: { imageId: string; serverIds: string[] }) =>
      api.post(`/admin/groups/${groupId}/image-grants/${imageId}/sync-servers`, { serverIds }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['group-image-grants', groupId] }); toast({ title: '镜像授权已更新' }); },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const getGrantedServers = (imageId: string) =>
    new Set(grants.filter((g) => g.imageId === imageId).map((g) => g.serverId));

  const imageIds = new Set(images.map((img) => img.id));
  const orphanedImageIds = [...new Set(grants.filter((g) => !imageIds.has(g.imageId)).map((g) => g.imageId))];

  const serverMap = new Map(servers.map((s) => [s.id, s]));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">选择每个镜像可在哪些服务器上使用</p>
      {images.map((img) => {
        const grantedServerIds = getGrantedServers(img.id);
        return (
          <div key={img.id} className="bg-background rounded-lg border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="font-medium text-foreground">{img.name}</span>
                <span className="text-xs text-muted-foreground ml-2 font-mono">{img.dockerImage}</span>
              </div>
              {!img.isActive && <Badge variant="outline" className="text-xs">已停用</Badge>}
            </div>
            <div className="flex flex-wrap gap-2">
              {servers.map((s) => {
                const granted = grantedServerIds.has(s.id);
                const toggleServer = () => {
                  const newIds = new Set(grantedServerIds);
                  if (granted) newIds.delete(s.id);
                  else newIds.add(s.id);
                  syncServers.mutate({ imageId: img.id, serverIds: Array.from(newIds) });
                };
                return (
                  <button key={s.id}
                    onClick={toggleServer}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      granted
                        ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                        : 'bg-muted border-border text-muted-foreground hover:bg-muted/80'
                    }`}>
                    {s.name}
                  </button>
                );
              })}
              {servers.length === 0 && <span className="text-xs text-muted-foreground/50">暂无服务器</span>}
            </div>
          </div>
        );
      })}

      {orphanedImageIds.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-red-100">
          <p className="text-xs text-red-500">以下镜像已被删除，存在残留授权：</p>
          {orphanedImageIds.map((imageId) => {
            const grantedServers = grants
              .filter((g) => g.imageId === imageId)
              .map((g) => serverMap.get(g.serverId)?.name ?? g.serverId);
            return (
              <div key={imageId} className="flex items-center justify-between bg-red-50 border border-red-100 rounded-lg px-4 py-3">
                <div>
                  <span className="text-sm font-mono text-red-700">[已删除] {imageId.slice(0, 8)}…</span>
                  <div className="text-xs text-red-400 mt-0.5">{grantedServers.join('、')}</div>
                </div>
                <Button size="sm" variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-100"
                  onClick={() => syncServers.mutate({ imageId, serverIds: [] })}>
                  <Trash2 className="h-4 w-4" />移除
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
