import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, Plus, RefreshCw } from 'lucide-react';
import { Capability, zCreateSharedBackendRequest, type CreateSharedBackendRequest, type SharedBackendDto } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { FormField } from '../components/layout/form-field.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ResourceGrid } from '../components/layout/resource-grid.js';
import { FsidConflictAlert } from '../components/storage/fsid-conflict-alert.js';
import { approxGibHint, formatPercent, sharedBackendAvailableBytes } from '../lib/utils.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';
import {
  parseSharedBackendFsidConflict,
  type SharedBackendFsidConflict,
} from '../lib/storage-shrink.js';

export default function SharedBackendsPage() {
  const queryClient = useQueryClient();
  const canManageSharedVolumes = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageSharedVolumes) ?? false,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SharedBackendDto | null>(null);
  const [pageConflict, setPageConflict] = useState<SharedBackendFsidConflict | null>(null);
  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.admin,
    queryFn: () => api.get<SharedBackendDto[]>('/admin/shared-backends'),
  });
  const deleteBackend = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/admin/shared-backends/${id}`),
    onSuccess: () => {
      toast({ title: '共享后端已删除' });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
    },
    onError: (error) => {
      const conflict = parseSharedBackendFsidConflict(error);
      if (conflict) setPageConflict(conflict);
      toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' });
    },
  });
  return (
    <Page testId="shared-backends">
      <PageHeader
        title="共享存储"
        description="登记跨服务器共用的 CephFS 后端。用户共享卷请到「共享卷管理」查看 catalog；此处不创建或删除用户卷。"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void backendsQuery.refetch(); }} aria-label="刷新共享后端">
              <RefreshCw className="h-4 w-4" />
            </Button>
            {canManageSharedVolumes && (
              <Button variant="outline" asChild>
                <Link to="/manage/shared-volumes">共享卷管理 / 查看 catalog</Link>
              </Button>
            )}
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />登记后端</Button>
          </>
        }
      />
      {pageConflict && (
        <FsidConflictAlert conflict={pageConflict} onDismiss={() => setPageConflict(null)} />
      )}
      <QueryView
        query={backendsQuery}
        resourceName="共享后端"
        loadingLabel="加载共享后端..."
        showEmpty={backendsQuery.data?.length === 0}
        empty={
          <EmptyState
            title="暂无共享存储。登记 CephFS 后端后可在「共享卷」页预订容量。"
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />登记后端</Button>}
          />
        }
      >
        {(backends) => (
          <ResourceGrid>
            {backends.map((backend) => (
              <Card key={backend.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <CardTitle className="flex min-w-0 items-center gap-2 text-base">
                      <Database className="h-4 w-4 shrink-0" />
                      <span className="truncate">{backend.displayName ?? backend.name}</span>
                    </CardTitle>
                    <Badge variant="outline">{backend.serverIds.length} 台服务器</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Info label="identity key" value={backend.identityKey} mono />
                    <Info label="Ceph FSID" value={backend.cephFsid} mono />
                    <Info label="容量" value={backend.totalBytes === null ? '未知' : approxGibHint(backend.totalBytes).replace(/^约 /, '')} />
                    <Info label="已用" value={backend.usedBytes === null ? '未知' : approxGibHint(backend.usedBytes).replace(/^约 /, '')} />
                    <Info
                      label="可用"
                      value={(() => {
                        const available = sharedBackendAvailableBytes(backend);
                        return available === null ? '未知' : approxGibHint(available).replace(/^约 /, '');
                      })()}
                    />
                    <Info label="超分比例" value={formatPercent(backend.overcommitRatio)} />
                    <Info label="可见服务器" value={backend.serverIds.join(', ') || '尚未发现'} mono />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setDeleteTarget(backend)}
                      disabled={deleteBackend.isPending}
                    >
                      删除
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </ResourceGrid>
        )}
      </QueryView>
      <CreateSharedBackendDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onConflict={(conflict) => setPageConflict(conflict)}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除共享后端？"
        description={
          <>
            将删除登记「{deleteTarget?.displayName ?? deleteTarget?.name}」。仍有关联存储池或数据卷时后端可能拒绝删除。
            {deleteTarget && (
              <dl className="mt-3 space-y-2 rounded-md border px-3 py-3 text-sm text-foreground">
                <div>
                  <dt className="text-xs text-muted-foreground">显示名称</dt>
                  <dd>{deleteTarget.displayName ?? deleteTarget.name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">identity key</dt>
                  <dd className="break-all font-mono text-xs">{deleteTarget.identityKey}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Ceph FSID</dt>
                  <dd className="break-all font-mono text-xs">{deleteTarget.cephFsid}</dd>
                </div>
              </dl>
            )}
          </>
        }
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={deleteBackend.isPending}
        testId="shared-backend-delete-confirm"
        onConfirm={() => { if (deleteTarget) deleteBackend.mutate(deleteTarget.id); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </Page>
  );
}

function CreateSharedBackendDialog({
  open,
  onOpenChange,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConflict: (conflict: SharedBackendFsidConflict) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    displayName: '',
    identityKey: '',
    cephFsid: '',
    overcommitRatio: '1',
  });
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SharedBackendFsidConflict | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateSharedBackendRequest) => api.post<SharedBackendDto>('/admin/shared-backends', body),
    onSuccess: () => {
      toast({ title: '共享后端已登记' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
      setConflict(null);
      onOpenChange(false);
    },
    onError: (mutationError) => {
      const parsed = parseSharedBackendFsidConflict(mutationError);
      if (parsed) {
        setConflict(parsed);
        onConflict(parsed);
        setError(null);
        return;
      }
      setConflict(null);
      setError(errorMessage(mutationError));
    },
  });
  const submit = () => {
    const parsed = zCreateSharedBackendRequest.safeParse({
      ...form,
      displayName: form.displayName || null,
      overcommitRatio: Number(form.overcommitRatio),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查共享后端参数');
      return;
    }
    setConflict(null);
    create.mutate(parsed.data);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setConflict(null);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="shared-backend-form">
        <DialogHeader>
          <DialogTitle>登记共享后端</DialogTitle>
          <DialogDescription>
            identity key 用于跨服务器合并；FSID 不一致时会拒绝合并并以红色告警展示冲突详情。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {(
            [
              ['name', '名称', 'cephfs-prod'],
              ['displayName', '显示名称', '生产 CephFS'],
              ['identityKey', 'Identity key', 'cephfs:cluster/source/path'],
              ['cephFsid', 'Ceph FSID', '00000000-0000-0000-0000-000000000000'],
              ['overcommitRatio', '超分比例', '1'],
            ] as const
          ).map(([key, label, placeholder]) => (
            <FormField key={key} id={`shared-backend-${key}`} label={label}>
              <Input
                id={`shared-backend-${key}`}
                value={form[key]}
                placeholder={placeholder}
                onChange={(event) => {
                  const value = event.target.value;
                  setForm((current) => ({ ...current, [key]: value }));
                  setError(null);
                  setConflict(null);
                }}
              />
            </FormField>
          ))}
          {conflict && <FsidConflictAlert conflict={conflict} />}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={create.isPending}>{create.isPending ? '登记中...' : '登记'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? 'break-all font-mono text-xs' : 'break-all text-sm'}>{value}</p>
    </div>
  );
}
