import { useQuery } from '@tanstack/react-query';
import type { SharedVolumeCatalogInspectDto, SharedVolumeDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { catalogOccupancyLabel, shouldSkipCatalogInspectRow } from '../../lib/catalog-occupancy.js';
import { queryKeys } from '../../lib/query-keys.js';
import { serverStatusLabel } from '../../lib/status-labels.js';
import { QueryView } from '../layout/query-view.js';
import { Badge } from '../ui/badge.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';

const PG_STATE_LABEL = {
  ensuring: '登记中',
  present: '已存在',
  absent: '无',
} as const;

function occupancyVariant(occupancy: SharedVolumeCatalogInspectDto['items'][number]['occupancy']) {
  if (occupancy === 'in_use') return 'success' as const;
  if (occupancy === 'dangling_pg' || occupancy === 'dangling_incus') return 'destructive' as const;
  if (occupancy === 'ensuring' || occupancy === 'unreachable') return 'warning' as const;
  return 'secondary' as const;
}

export function SharedVolumeCatalogInspectDialog({
  volume,
  open,
  onOpenChange,
}: {
  volume: SharedVolumeDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useQuery({
    queryKey: queryKeys.sharedVolumes.catalogs(volume?.id ?? ''),
    queryFn: () => api.get<SharedVolumeCatalogInspectDto>(`/admin/shared-volumes/${volume!.id}/catalogs`),
    enabled: open && Boolean(volume),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl" data-testid="shared-volume-catalog-inspect">
        <DialogHeader>
          <DialogTitle>Catalog 查看</DialogTitle>
          <DialogDescription>
            {volume
              ? `「${volume.name}」在各机上的 catalog 占用（只读）。从未见过此卷的节点已省略。`
              : '只读查看共享卷 catalog。'}
          </DialogDescription>
        </DialogHeader>
        {volume && (
          <QueryView
            query={query}
            resourceName="catalog"
            loadingLabel="加载 catalog..."
          >
            {(inspect) => {
              const items = inspect.items.filter((item) => !shouldSkipCatalogInspectRow(item));
              if (items.length === 0) {
                return (
                  <p className="text-sm text-muted-foreground">
                    没有可见的 catalog（从未见过此卷的节点已省略）。
                  </p>
                );
              }
              return (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>服务器</TableHead>
                      <TableHead>池</TableHead>
                      <TableHead>PG</TableHead>
                      <TableHead>Incus</TableHead>
                      <TableHead>占用</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={`${item.serverId}:${item.poolId ?? 'none'}`}>
                        <TableCell>
                          <div>{item.serverName}</div>
                          <div className="text-xs text-muted-foreground">{serverStatusLabel(item.serverStatus)}</div>
                        </TableCell>
                        <TableCell>{item.poolName ?? '—'}</TableCell>
                        <TableCell>{PG_STATE_LABEL[item.pgCatalogState]}</TableCell>
                        <TableCell>
                          {item.incusPresent === null ? '超时' : item.incusPresent ? '有' : '无'}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={occupancyVariant(item.occupancy)}
                            data-testid="catalog-occupancy"
                          >
                            {catalogOccupancyLabel(item.occupancy)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              );
            }}
          </QueryView>
        )}
      </DialogContent>
    </Dialog>
  );
}
