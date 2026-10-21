import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { HttpDomainPoolDto, HttpProxyBindingDto } from '@nyabase/common';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { SectionCard } from '../../components/layout/section-card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { httpProxyBindingStatusLabel, httpProxyWarningLabel } from '../../lib/http-proxy.js';

export function DomainPoolsCard({
  pools,
  refreshing,
  onRefresh,
  onCreate,
  onEdit,
  onDelete,
}: {
  pools: HttpDomainPoolDto[];
  refreshing: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  onEdit: (pool: HttpDomainPoolDto) => void;
  onDelete: (pool: HttpDomainPoolDto) => void;
}) {
  return (
    <SectionCard
      title="域名池"
      actions={
        <>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={onCreate}><Plus className="h-4 w-4" />新建域名池</Button>
        </>
      }
      flush={pools.length > 0}
    >
      {pools.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          暂无域名池。登记通配域名后，用户才能把容器端口发布到匹配的主机名。
        </p>
      ) : (
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow>
              <TableHead>通配域名</TableHead>
              <TableHead>启用</TableHead>
              <TableHead>HTTPS</TableHead>
              <TableHead>证书</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pools.map((pool) => (
              <TableRow key={pool.id}>
                <TableCell className="font-mono text-xs">{pool.wildcardDomain}</TableCell>
                <TableCell>{pool.enabled ? '是' : '否'}</TableCell>
                <TableCell>{pool.httpsEnabled ? '是' : '否'}</TableCell>
                <TableCell>
                  {pool.certificateFingerprint ? (
                    <TechnicalId label="证书指纹" value={pool.certificateFingerprint} kind="opaque" />
                  ) : (
                    <span className="text-sm">未配置</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => onEdit(pool)}>
                      <Pencil className="h-3.5 w-3.5" />编辑
                    </Button>
                    <Button size="sm" variant="ghost-destructive" onClick={() => onDelete(pool)}>
                      <Trash2 className="h-3.5 w-3.5" />删除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

export function AllBindingsCard({ bindings }: { bindings: HttpProxyBindingDto[] }) {
  return (
    <SectionCard title="全部发布绑定" flush={bindings.length > 0}>
      {bindings.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无用户发布绑定。</p>
      ) : (
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>所有者</TableHead>
              <TableHead>主机名</TableHead>
              <TableHead>容器</TableHead>
              <TableHead>端口</TableHead>
              <TableHead>HTTPS</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bindings.map((binding) => (
              <TableRow key={binding.id}>
                <TableCell>{binding.ownerUsername}</TableCell>
                <TableCell className="font-mono text-xs">{binding.hostname}</TableCell>
                <TableCell>{binding.containerName ?? binding.containerId}</TableCell>
                <TableCell>{binding.targetPort}</TableCell>
                <TableCell>{binding.entryHttpsEnabled ? '是' : '否'}</TableCell>
                <TableCell>
                  <Badge variant={binding.status === 'ready' ? 'success' : binding.status === 'warning' ? 'warning' : 'secondary'}>
                    {httpProxyBindingStatusLabel(binding.status)}
                  </Badge>
                  {binding.warningReasons.length > 0 && (
                    <p className="mt-1 text-xs text-destructive">{httpProxyWarningLabel(binding.warningReasons)}</p>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
