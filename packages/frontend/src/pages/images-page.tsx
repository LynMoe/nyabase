import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { ImageDto } from '@nyabase/common';

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

export default function ImagesPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<ImageDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ImageDto | null>(null);
  const qc = useQueryClient();

  const { data: images = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: queryKeys.images.admin,
    queryFn: () => api.get<ImageDto[]>('/admin/images'),
    refetchInterval: 30_000,
  });

  const deleteImg = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/images/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.images.admin });
      toast({ title: '镜像已删除' });
    },
    onError: (e) => toast({ title: '删除失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="p-6 space-y-4 w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">容器镜像</h1>
          <p className="text-muted-foreground text-sm">{images.length} 个预置镜像</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost" size="icon"
            className="h-8 w-8 text-muted-foreground"
            onClick={() => refetch()} disabled={isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />添加镜像
          </Button>
        </div>
      </div>

      <ImageList
        images={images}
        isLoading={isLoading}
        onCreate={() => setShowCreate(true)}
        onEdit={(img) => setEditTarget(img)}
        onDelete={(img) => setDeleteTarget(img)}
      />

      <ImageFormDialog
        mode="create"
        open={showCreate}
        onOpenChange={setShowCreate}
      />
      <ImageFormDialog
        mode="edit"
        image={editTarget}
        open={!!editTarget}
        onOpenChange={(open) => { if (!open) setEditTarget(null); }}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除镜像？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可撤销，将删除镜像{' '}
              <span className="font-semibold text-foreground">{deleteTarget?.name}</span>。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteTarget) deleteImg.mutate(deleteTarget.id); }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
