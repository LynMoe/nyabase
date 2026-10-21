import { Pencil, Trash2 } from 'lucide-react';
import type { HttpProxyBindingDto } from '@nyabase/common';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { TableCell, TableRow } from '../../components/ui/table.js';
import { httpProxyBindingStatusLabel, httpProxyWarningLabel } from '../../lib/http-proxy.js';

export function BindingRow({
  binding,
  onEdit,
  onDelete,
}: {
  binding: HttpProxyBindingDto;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const warning = httpProxyWarningLabel(binding.warningReasons);
  return (
    <TableRow className="cursor-pointer" onClick={onEdit}>
      <TableCell className="font-mono">{binding.hostname}</TableCell>
      <TableCell className="whitespace-normal">
        <Badge variant={binding.status === 'ready' ? 'success' : binding.status === 'warning' ? 'warning' : 'secondary'}>
          {httpProxyBindingStatusLabel(binding.status)}
        </Badge>
        {(warning || binding.warningMessage) ? (
          <p className="mt-1 text-xs text-destructive">{warning || binding.warningMessage}</p>
        ) : null}
      </TableCell>
      <TableCell>{binding.containerName ?? binding.containerId}</TableCell>
      <TableCell>{binding.targetPort}</TableCell>
      <TableCell>{binding.entryHttpsEnabled ? '已启用' : '未启用'}</TableCell>
      <TableCell className="font-mono">{binding.domainPool}</TableCell>
      <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5" />编辑</Button>
          <Button size="sm" variant="ghost-destructive" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" />删除</Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
