import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import type { AdminImageDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../components/ui/alert-dialog.js';
import { ImageFormDialog } from '../components/images/image-form-dialog.js';
import { ImageList } from '../components/images/image-list.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';

export default function ImagesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminImageDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminImageDto | null>(null);
  const imagesQuery = useQuery({
    queryKey: queryKeys.images.admin,
    queryFn: () => api.get<AdminImageDto[]>('/admin/images'),
  });
  const deleteImage = useMutation({
    mutationFn: (imageId: string) => api.delete<unknown>(`/admin/images/${imageId}`),
    onSuccess: () => {
      toast({ title: '镜像删除意图已提交' });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.admin });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });

  return (
    <div className="space-y-5 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">镜像</h1><p className="text-sm text-muted-foreground">管理镜像元数据与每台服务器的指纹分配。</p></div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => { void imagesQuery.refetch(); }} disabled={imagesQuery.isFetching} aria-label="刷新镜像">
            <RefreshCw className={imagesQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />添加镜像</Button>
        </div>
      </div>
      {imagesQuery.isLoading ? <QueryLoadingState label="加载镜像..." /> : imagesQuery.isError ? (
        <QueryErrorState error={imagesQuery.error} resourceName="镜像目录" onRetry={() => { void imagesQuery.refetch(); }} />
      ) : (
        <ImageList
          images={imagesQuery.data ?? []}
          onEdit={setEditTarget}
          onDelete={setDeleteTarget}
          onCreate={() => setCreateOpen(true)}
        />
      )}
      <ImageFormDialog mode="create" open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && <ImageFormDialog mode="edit" image={editTarget} open onOpenChange={(open) => { if (!open) setEditTarget(null); }} />}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>删除镜像？</AlertDialogTitle><AlertDialogDescription>删除会先移除服务器上的指纹分配；仍被容器引用的镜像会由后端拒绝。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (deleteTarget) deleteImage.mutate(deleteTarget.id); }} disabled={deleteImage.isPending}>{deleteImage.isPending ? '提交中...' : '确认删除'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}
