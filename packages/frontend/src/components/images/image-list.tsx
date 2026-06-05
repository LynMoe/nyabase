import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle, Download, ImageIcon, Loader2, Pencil, Plus,
} from 'lucide-react';
import type { ImageDto } from '@nyabase/common';

import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { useAuthStore } from '../../store/auth.js';
import { toast } from '../../hooks/use-toast.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '../ui/card.js';
import { Separator } from '../ui/separator.js';

import type { ServerStatus } from './types.js';
import { ServerStatusRow } from './pull-progress-dialog.js';

interface ImageListProps {
  images: ImageDto[];
  isLoading: boolean;
  onCreate: () => void;
  onEdit: (image: ImageDto) => void;
  onDelete: (image: ImageDto) => void;
}

export function ImageList({ images, isLoading, onCreate, onEdit, onDelete }: ImageListProps) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/admin/images/${id}`, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.images.admin }),
  });

  if (isLoading) {
    return <Card><CardContent className="h-32 animate-pulse bg-muted/50 rounded-lg mt-6" /></Card>;
  }

  if (images.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 space-y-3">
          <ImageIcon className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">还没有预置镜像</p>
          <Button size="sm" onClick={onCreate}>
            <Plus className="h-4 w-4" />添加镜像
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {images.map((img) => (
        <ImageCard
          key={img.id}
          image={img}
          onToggle={() => toggle.mutate({ id: img.id, isActive: !img.isActive })}
          onEdit={() => onEdit(img)}
          onDelete={() => onDelete(img)}
        />
      ))}
    </div>
  );
}

interface ImageCardProps {
  image: ImageDto;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function ImageCard({ image, onToggle, onEdit, onDelete }: ImageCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [statuses, setStatuses] = useState<ServerStatus[]>([]);
  const sseRef = useRef<EventSource | null>(null);

  const {
    data: fetchedStatuses, refetch, isPending: statusPending, isError: statusError,
  } = useQuery({
    queryKey: queryKeys.images.status(image.id),
    queryFn: () => api.get<ServerStatus[]>(`/admin/images/${image.id}/status`),
    enabled: expanded,
    refetchInterval: expanded ? 5_000 : false,
  });

  useEffect(() => {
    if (fetchedStatuses) setStatuses(fetchedStatuses);
  }, [fetchedStatuses]);

  const pullAll = useMutation({
    mutationFn: (serverIds?: string[]) =>
      api.post<{ started: string[]; skipped: string[] }>(
        `/admin/images/${image.id}/pull`,
        { serverIds },
      ),
    onSuccess: (res) => {
      if (res.started.length > 0) {
        setPulling(true);
        openSse();
        toast({ title: `已在 ${res.started.length} 台服务器上开始 pull` });
      }
      if (res.skipped.length > 0) {
        toast({ title: `${res.skipped.length} 台服务器离线，已跳过`, variant: 'destructive' });
      }
    },
    onError: (e) => toast({ title: 'Pull 失败', description: e.message, variant: 'destructive' }),
  });

  const openSse = () => {
    sseRef.current?.close();
    const token = useAuthStore.getState().accessToken ?? '';
    const es = new EventSource(`/api/admin/images/${image.id}/pull-progress?token=${token}`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.heartbeat) return;
        setStatuses(data);
        refetch();
        if ((data as ServerStatus[]).every((s) => !s.pulling)) {
          setPulling(false);
          es.close();
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { es.close(); setPulling(false); };
    sseRef.current = es;
  };

  useEffect(() => () => sseRef.current?.close(), []);

  const onlineServers = statuses.filter((s) => s.online);
  const presentCount = statuses.filter((s) => s.present).length;
  const pullingCount = statuses.filter((s) => s.pulling).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">{image.name}</CardTitle>
                <Badge
                  variant={image.isActive ? 'success' : 'secondary'}
                  className="cursor-pointer text-xs"
                  onClick={onToggle}
                >
                  {image.isActive ? '启用' : '停用'}
                </Badge>
              </div>
              <CardDescription className="font-mono text-xs mt-0.5">{image.dockerImage}</CardDescription>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {statuses.length > 0 && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground mr-2">
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                <span>{presentCount}/{statuses.length}</span>
                {pullingCount > 0 && (
                  <span className="flex items-center gap-0.5 text-blue-500">
                    <Loader2 className="h-3 w-3 animate-spin" />{pullingCount}
                  </span>
                )}
              </div>
            )}

            <Button
              variant="outline" size="sm" className="h-8"
              onClick={() => { setExpanded(!expanded); if (!expanded) refetch(); }}
            >
              {expanded ? '收起' : '展开详情'}
            </Button>

            {onlineServers.length > 0 && (
              <Button
                size="sm" className="h-8"
                disabled={pullAll.isPending || pulling}
                onClick={() => { if (!expanded) setExpanded(true); pullAll.mutate(undefined); }}
              >
                {pulling ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" />Pull 中...</>
                ) : (
                  <><Download className="h-3.5 w-3.5" />Pull 全部</>
                )}
              </Button>
            )}

            <Button
              variant="ghost" size="sm"
              className="h-8 text-muted-foreground"
              onClick={onEdit} title="编辑镜像参数"
            >
              <Pencil className="h-3.5 w-3.5" />编辑
            </Button>
            <Button
              variant="ghost" size="sm"
              className="h-8 text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              删除
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground mt-1">
          <span>UID: <code className="bg-muted px-1 py-0.5 rounded">{image.runtimeOverrides?.uid ?? image.defaultUid}</code></span>
          {image.runtimeOverrides?.entrypoint && (
            <span>Entrypoint: <code className="bg-muted px-1 py-0.5 rounded">{image.runtimeOverrides.entrypoint.join(' ')}</code></span>
          )}
          {image.runtimeOverrides?.cmd && (
            <span>CMD: <code className="bg-muted px-1 py-0.5 rounded">{image.runtimeOverrides.cmd.join(' ')}</code></span>
          )}
          {image.runtimeOverrides?.init && <span>Init mode</span>}
          {image.description && <span>{image.description}</span>}
        </div>
      </CardHeader>

      {expanded && (
        <>
          <Separator />
          <CardContent className="pt-4">
            {statusError ? (
              <p className="text-sm text-destructive text-center py-4">
                加载服务器状态失败，请检查权限或稍后重试
              </p>
            ) : statusPending ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                正在加载服务器状态...
              </p>
            ) : statuses.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                暂无服务器连接此系统
              </p>
            ) : (
              <div className="space-y-2">
                {statuses.map((s) => (
                  <ServerStatusRow
                    key={s.serverId}
                    status={s}
                    onPull={() => pullAll.mutate([s.serverId])}
                    pulling={pulling}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </>
      )}
    </Card>
  );
}
