import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import type { AdminImageDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ImageFormDialog } from '../components/images/image-form-dialog.js';
import { ImageList } from '../components/images/image-list.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';

export default function ImagesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
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
    <Page>
      <PageHeader
        title="镜像"
        description="管理镜像元数据与每台服务器的指纹分配。"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void imagesQuery.refetch(); }} disabled={imagesQuery.isFetching} aria-label="刷新镜像">
              <RefreshCw className={imagesQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </Button>
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />添加镜像</Button>
          </>
        }
      />
      <QueryView
        query={imagesQuery}
        resourceName="镜像目录"
        loadingLabel="加载镜像..."
        showEmpty={imagesQuery.data?.length === 0}
        empty={
          <EmptyState
            title="暂无镜像。"
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />添加镜像</Button>}
          />
        }
      >
        {(images) => (
          <ImageList
            images={images}
            onDelete={setDeleteTarget}
          />
        )}
      </QueryView>
      <ImageFormDialog mode="create" open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除镜像？"
        description="删除会先移除服务器上的指纹分配；仍被容器引用的镜像会由后端拒绝。"
        confirmLabel="确认删除"
        pendingLabel="提交中..."
        pending={deleteImage.isPending}
        onConfirm={() => { if (deleteTarget) deleteImage.mutate(deleteTarget.id); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </Page>
  );
}
