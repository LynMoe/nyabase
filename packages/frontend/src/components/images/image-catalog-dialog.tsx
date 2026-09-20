import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CatalogImageDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { formatBytes } from '../../lib/utils.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';

export function ImageCatalogDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({
    queryKey: queryKeys.images.catalog,
    queryFn: () => api.get<CatalogImageDto[]>('/admin/images/catalog'),
    enabled: open,
  });
  const addImage = useMutation({
    mutationFn: (alias: string) => api.post<unknown>('/admin/images', { alias }),
    onSuccess: (_, alias) => {
      toast({ title: '镜像已添加', description: alias });
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.admin });
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.catalog });
    },
    onError: (error) => toast({ title: '添加失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const entries = catalogQuery.data ?? [];
  const available = entries.filter((entry) => !entry.added);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="incus-image-catalog" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>添加镜像</DialogTitle>
          <DialogDescription>从镜像源选择已发布的系统镜像。不能手写别名。</DialogDescription>
        </DialogHeader>
        {catalogQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">正在读取镜像源...</p>
        ) : catalogQuery.isError ? (
          <p className="text-sm text-destructive">{errorMessage(catalogQuery.error)}</p>
        ) : available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {entries.length === 0 ? '镜像源没有可添加的容器镜像。' : '目录中的镜像都已添加。'}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {available.map((entry) => (
              <li key={entry.alias} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium">{entry.description}</p>
                  <p className="font-mono text-xs text-muted-foreground">{entry.alias}</p>
                  <p className="text-xs text-muted-foreground">
                    {entry.sizeBytes ? formatBytes(entry.sizeBytes) : '大小未知'}
                    {' · '}
                    {entry.fingerprint.slice(0, 12)}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={addImage.isPending}
                  onClick={() => addImage.mutate(entry.alias)}
                >
                  添加
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
