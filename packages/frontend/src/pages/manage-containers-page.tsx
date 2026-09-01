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
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { ContainerRow } from '../components/containers/container-row.js';
import { FormField } from '../components/layout/form-field.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { runGatedMutation } from '../lib/resource-mutation-gate.js';
import { actionProgressHint, containerActionSubmittedTitle } from '../lib/status-labels.js';
import { toast } from '../hooks/use-toast.js';

export default function ManageContainersPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.adminList,
    queryFn: () => api.get<ContainerDto[]>('/admin/containers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 5_000 }),
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
    onError: (error) => toast({ title: '容器操作失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const groups = useMemo(() => {
    const map = new Map<string, ContainerDto[]>();
    for (const container of containersQuery.data ?? []) map.set(container.ownerId, [...(map.get(container.ownerId) ?? []), container]);
    return [...map.entries()];
  }, [containersQuery.data]);

  const onPowerAction = async (actionName: ContainerAction, container: ContainerDto) => {
    if (actionName === 'start' || actionName === 'stop' || actionName === 'restart') {
      const ran = await runGatedMutation(container.id, () =>
        action.mutateAsync({ actionName, containerId: container.id }).then(() => undefined),
      );
      if (!ran) return Promise.reject();
    }
  };

  return (
    <Page>
      <PageHeader
        title="容器管理"
        description="全部用户的容器（管理面）。你自己的容器仍在「容器」。"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            代建容器
          </Button>
        }
      />
      <QueryView
        query={containersQuery}
        resourceName="全局容器"
        loadingLabel="加载全局容器..."
        showEmpty={containersQuery.data?.length === 0}
        empty={<EmptyState title="暂无容器。" />}
      >
        {(_containers) => (
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
                        onAction={onPowerAction}
                      />
                    ))}
                  </CardContent>
                </Card>
              </section>
            ))}
          </div>
        )}
      </QueryView>
      <AdminCreateContainerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.containers.adminList });
        }}
      />
    </Page>
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
      description: errorMessage(error),
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
          <FormField id="admin-container-name" label="名称">
            <Input id="admin-container-name" value={name} onChange={(event) => setName(event.target.value)} />
          </FormField>
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
    <FormField id={id} label={label}>
      <Select key={value || 'empty'} value={value || undefined} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}
