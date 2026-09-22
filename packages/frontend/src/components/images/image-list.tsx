import { Link } from '@tanstack/react-router';
import { RefreshCw, Trash2 } from 'lucide-react';
import type { AdminImageDto } from '@nyabase/common';
import { Button } from '../ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';
import { SectionCard } from '../layout/section-card.js';
import { StatusBadge } from '../layout/status-badge.js';
import { TechnicalId } from '../refs/technical-id.js';
import { imageInProgress } from '../../lib/in-progress.js';

export function ImageList({
  images,
  onRepull,
  onDelete,
  busyId,
}: {
  images: AdminImageDto[];
  onRepull: (image: AdminImageDto) => void;
  onDelete: (image: AdminImageDto) => void;
  busyId?: string | null;
}) {
  return (
    <SectionCard flush>
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHead>别名</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>指纹</TableHead>
            <TableHead>分配</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {images.map((image) => (
            <TableRow key={image.id}>
              <TableCell className="whitespace-normal">
                {image.alias.length > 64 ? (
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <TechnicalId label="别名" value={image.alias} kind="opaque" />
                    <Link
                      to="/images/$id"
                      params={{ id: image.id }}
                      search={{ tab: 'overview' }}
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      打开
                    </Link>
                  </div>
                ) : (
                  <Link
                    to="/images/$id"
                    params={{ id: image.id }}
                    search={{ tab: 'overview' }}
                    className="block min-w-0"
                  >
                    <p className="font-mono text-sm">{image.alias}</p>
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <StatusBadge
                  label={image.deleting ? '清理中' : image.isActive ? '可用' : '停用'}
                  pending={imageInProgress(image)}
                  variant={image.isActive && !image.deleting ? 'success' : 'secondary'}
                />
              </TableCell>
              <TableCell>
                {image.fingerprint
                  ? <TechnicalId label="指纹" value={image.fingerprint} kind="fingerprint" />
                  : <span className="text-sm">尚未收敛</span>}
              </TableCell>
              <TableCell>{image.assignments.length} 台</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={image.deleting || busyId === image.id}
                    onClick={() => onRepull(image)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />重新拉取
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={image.deleting || busyId === image.id}
                    onClick={() => onDelete(image)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />移除
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
