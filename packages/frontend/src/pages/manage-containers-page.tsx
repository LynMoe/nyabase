import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserRound } from 'lucide-react';
import {
  ContainerPowerIntent,
  UserStatus,
  type AdminImageDto,
  type ContainerAction,
  type ContainerDto,
  type IntentAcceptedDto,
  type ServerDto,
  type UserDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { ContainerRow } from '../components/containers/container-row.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { queryKeys } from '../lib/query-keys.js';
import { actionProgressHint, containerActionSubmittedTitle } from '../lib/status-labels.js';
import { toast } from '../hooks/use-toast.js';

export default function ManageContainersPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.adminList,
    queryFn: () => api.get<ContainerDto[]>('/admin/containers'),
    refetchInterval: 5_000,
  });
  const action = useMutation({
    mutationFn: ({ actionName, containerId }: { actionName: Extract<ContainerAction, 'start' | 'stop' | 'restart'>; containerId: string }) =>
      api.post<IntentAcceptedDto>(`/admin/containers/${containerId}/actions/${actionName}`),
    onSuccess: (_intent, variables) => {
      toast({
        title: containerActionSubmittedTitle(variables.actionName),
        description: actionProgressHint('list'),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers.adminList });
    },
    onError: (error) => toast({ title: '容器操作失败', description: error instanceof Error ? error.message : '请稍后重试', variant: 'destructive' }),
  });
  const groups = useMemo(() => {
    const map = new Map<string, ContainerDto[]>();
    for (const container of containersQuery.data ?? []) map.set(container.ownerId, [...(map.get(container.ownerId) ?? []), container]);
    return [...map.entries()];
  }, [containersQuery.data]);

  if (containersQuery.isLoading) return <QueryLoadingState label="加载全局容器..." />;
  if (containersQuery.isError) {
    return <QueryErrorState error={containersQuery.error} resourceName="全局容器" onRetry={() => { void containersQuery.refetch(); }} />;
  }

  return (
    <div className="space-y-5 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">容器管理</h1>
          <p className="text-sm text-muted-foreground">全部用户的容器（管理面）。你自己的容器仍在「容器」。</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          代建容器
        </Button>
      </div>
      {groups.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">暂无容器。</CardContent></Card>
      ) : (
        <div className="space-y-5">
          {groups.map(([ownerId, containers]) => (
            <section key={ownerId} className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <UserRound className="h-4 w-4 text-muted-foreground" />
                {containers[0]?.ownerName ?? ownerId}
                <span className="text-xs text-muted-foreground">{containers.length} 个</span>
              </div>
              <Card>
                <CardContent className="divide-y p-0">
                  {containers.map((container) => (
                    <ContainerRow
                      key={container.id}
                      container={container}
                      admin
                      actionPending={action.isPending}
                      onAction={(actionName, item) => {
                        if (actionName === 'start' || actionName === 'stop' || actionName === 'restart') {
                          action.mutate({ actionName, containerId: item.id });
                        }
                      }}
                    />
                  ))}
                </CardContent>
              </Card>
            </section>
          ))}
        </div>
      )}
      <AdminCreateContainerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.containers.adminList });
        }}
      />
    </div>
  );
}

function AdminCreateContainerDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [ownerId, setOwnerId] = useState('');
  const [serverId, setServerId] = useState('');
  const [imageId, setImageId] = useState('');
  const [name, setName] = useState('');
  const usersQuery = useQuery({
    queryKey: queryKeys.users.admin,
    queryFn: () => api.get<UserDto[]>('/admin/users'),
    enabled: open,
  });
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/admin/servers'),
    enabled: open,
  });
  const imagesQuery = useQuery({
    queryKey: queryKeys.images.admin,
    queryFn: () => api.get<AdminImageDto[]>('/admin/images'),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: () => api.post<IntentAcceptedDto>('/admin/containers', {
      ownerId,
      serverId,
      imageId,
      name,
      rootSizeBytes: 20 * 1024 ** 3,
      cpuMillis: 1000,
      memBytes: 2 * 1024 ** 3,
      gpuPciAddresses: [],
      powerIntent: ContainerPowerIntent.Running,
    }),
    onSuccess: () => {
      toast({ title: '已提交代建', description: actionProgressHint('list') });
      onOpenChange(false);
      setOwnerId('');
      setServerId('');
      setImageId('');
      setName('');
      onCreated();
    },
    onError: (error) => toast({
      title: '代建失败',
      description: error instanceof Error ? error.message : '请稍后重试',
      variant: 'destructive',
    }),
  });
  const owners = (usersQuery.data ?? []).filter((user) => user.status === UserStatus.Active);
  const images = (imagesQuery.data ?? []).filter((image) => image.isActive && !image.deleting);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>代建容器</DialogTitle>
          <DialogDescription>以管理员身份为指定用户创建容器，不消耗该用户的存储额度。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field id="admin-owner" label="所有者" value={ownerId} onChange={setOwnerId} options={owners.map((user) => [user.id, user.displayName || user.username])} />
          <Field id="admin-server" label="服务器" value={serverId} onChange={setServerId} options={(serversQuery.data ?? []).map((server) => [server.id, server.name])} />
          <Field id="admin-image" label="镜像" value={imageId} onChange={setImageId} options={images.map((image) => [image.id, image.name])} />
          <div className="space-y-1.5">
            <Label htmlFor="admin-container-name">名称</Label>
            <Input id="admin-container-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!ownerId || !serverId || !imageId || !name || create.isPending}
            onClick={() => create.mutate()}
          >
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">请选择</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </div>
  );
}
