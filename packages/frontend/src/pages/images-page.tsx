import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { AdminImageDto, AgentTaskStatus } from '@nyabase/common';

import { api } from '../lib/api.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';
import { Button } from '../components/ui/button.js';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../components/ui/alert-dialog.js';
import { ImageList } from '../components/images/image-list.js';
import { ImageFormDialog } from '../components/images/image-form-dialog.js';
import { QueryErrorState } from '../components/query-state.js';
import { imageDeleteFeedback, imageListPollInterval } from '../lib/image-lifecycle-ui.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';

type DeleteImageResponse = {
  tasks: Array<{ serverId: string; taskId: string; status: AgentTaskStatus }>;
};

export default function ImagesPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminImageDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminImageDto | null>(null);
  const qc = useQueryClient();

  const imagesQuery = useQuery({
    queryKey: queryKeys.images.admin,
    queryFn: () => api.get<AdminImageDto[]>('/admin/images'),
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: imageListPollInterval(query.state.data),
      transientBaseIntervalMs: 2_000,
      transientMaxIntervalMs: 30_000,
    }),
  });
  const images = imagesQuery.data ?? [];
  const { isLoading, isFetching, refetch } = imagesQuery;
  const serverEditTarget = editTarget && imagesQuery.data
    ? (imagesQuery.data.find((image) => image.id === editTarget.id) ?? null)
    : editTarget;
  const currentDeleteTarget = deleteTarget && imagesQuery.data
    ? (imagesQuery.data.find((image) => image.id === deleteTarget.id) ?? null)
    : deleteTarget;

  const deleteImg = useMutation({
    mutationFn: (id: string) => api.delete<DeleteImageResponse>(`/admin/images/${id}`),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: queryKeys.images.admin });
      toast(imageDeleteFeedback(result.tasks.length));
      setDeleteTarget(null);
    },
    onError: (e) => toast({ title: '删除失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">容器镜像</h1>
          <p className="text-muted-foreground text-sm">
            {imagesQuery.data ? `${images.length} 个预置镜像` : '镜像数量尚未加载'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost" size="icon"
            className="h-8 w-8 text-muted-foreground"
            onClick={() => {
              if (editTarget && !window.confirm('刷新会保留镜像表单中的本地修改，并标记冲突。继续刷新？')) return;
              void refetch();
            }} disabled={isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={() => setShowCreate(true)} disabled={imagesQuery.isError}>
            <Plus className="h-4 w-4" />添加镜像
          </Button>
        </div>
      </div>

      {imagesQuery.isError ? (
        <QueryErrorState
          error={imagesQuery.error}
          resourceName="镜像目录"
          onRetry={() => { void imagesQuery.refetch(); }}
        />
      ) : (
        <ImageList
          images={images}
          isLoading={isLoading}
          onCreate={() => setShowCreate(true)}
          onEdit={(img) => setEditTarget(img)}
          onDelete={(img) => setDeleteTarget(img)}
        />
      )}

      {showCreate && (
        <ImageFormDialog
          mode="create"
          open
          onOpenChange={setShowCreate}
        />
      )}
      {editTarget && serverEditTarget && !serverEditTarget.deleting && (
        <ImageFormDialog
          mode="edit"
          image={editTarget}
          serverImage={serverEditTarget}
          open
          onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        />
      )}

      <AlertDialog
        open={!!currentDeleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{currentDeleteTarget?.deleting ? '重试镜像清理？' : '确认删除镜像？'}</AlertDialogTitle>
            <AlertDialogDescription>
              {currentDeleteTarget?.deleting
                ? '将为未完成的服务器重新排队清理任务；记录会在全部清理成功后移除。'
                : '删除会先排队清理所有服务器上的运行时镜像；记录会在全部成功后移除。'}{' '}
              <span className="font-semibold text-foreground">{currentDeleteTarget?.name}</span>。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (currentDeleteTarget) deleteImg.mutate(currentDeleteTarget.id); }}
              disabled={deleteImg.isPending}
            >
              {deleteImg.isPending ? '提交中...' : currentDeleteTarget?.deleting ? '重试清理' : '排队删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
