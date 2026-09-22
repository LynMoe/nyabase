import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, RefreshCw } from 'lucide-react';
import {
  zCreateSharedBackendRequest,
  type CreateSharedBackendRequest,
  type SharedBackendDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { FormField } from '../components/layout/form-field.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { TechnicalId } from '../components/refs/technical-id.js';
import { FsidConflictAlert } from '../components/storage/fsid-conflict-alert.js';
import { approxGibHint, formatPercent, sharedBackendAvailableBytes } from '../lib/utils.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';
import {
  parseSharedBackendFsidConflict,
  type SharedBackendFsidConflict,
} from '../lib/storage-shrink.js';

function bytesLabel(bytes: number | null): string {
  return bytes === null ? '未知' : approxGibHint(bytes).replace(/^约 /, '');
}

export default function SharedBackendsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [pageConflict, setPageConflict] = useState<SharedBackendFsidConflict | null>(null);
  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.admin,
    queryFn: () => api.get<SharedBackendDto[]>('/admin/shared-backends'),
  });

  return (
    <Page testId="shared-backends">
      <PageHeader
        title="共享存储"
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={() => { void backendsQuery.refetch(); }}
              aria-label="刷新共享后端"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
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
            title="暂无共享存储。"
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />登记后端</Button>}
          />
        }
      >
        {(backends) => (
          <SectionCard flush>
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>容量</TableHead>
                  <TableHead>已用</TableHead>
                  <TableHead>可用</TableHead>
                  <TableHead>超分</TableHead>
                  <TableHead>在线执行端</TableHead>
                  <TableHead>服务器</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backends.map((backend) => (
                  <BackendRow key={backend.id} backend={backend} />
                ))}
              </TableBody>
            </Table>
          </SectionCard>
        )}
      </QueryView>
      <CreateSharedBackendDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onConflict={(conflict) => setPageConflict(conflict)}
        onCreated={(backendId) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
          setCreateOpen(false);
          void navigate({
            to: '/shared-backends/$id',
            params: { id: backendId },
            search: { tab: 'executors' },
          });
        }}
      />
    </Page>
  );
}

function BackendRow({ backend }: { backend: SharedBackendDto }) {
  const available = sharedBackendAvailableBytes(backend);
  return (
    <TableRow className="cursor-pointer">
      <TableCell className="whitespace-normal">
        <Link
          to="/shared-backends/$id"
          params={{ id: backend.id }}
          search={{ tab: 'overview' }}
          className="block min-w-0 font-medium"
        >
          {backend.displayName ?? backend.name}
        </Link>
        <TechnicalId label="Identity key" value={backend.identityKey} kind="opaque" />
      </TableCell>
      <TableCell>{bytesLabel(backend.totalBytes)}</TableCell>
      <TableCell>{bytesLabel(backend.usedBytes)}</TableCell>
      <TableCell>{bytesLabel(available)}</TableCell>
      <TableCell>{formatPercent(backend.overcommitRatio)}</TableCell>
      <TableCell>{backend.hasOnlineExecutor ? '有' : '无'}</TableCell>
      <TableCell>{backend.serverIds.length} 台</TableCell>
    </TableRow>
  );
}

function CreateSharedBackendDialog({
  open,
  onOpenChange,
  onConflict,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConflict: (conflict: SharedBackendFsidConflict) => void;
  onCreated: (backendId: string) => void;
}) {
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
    onSuccess: (backend) => {
      toast({ title: '共享后端已登记' });
      setConflict(null);
      onCreated(backend.id);
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
