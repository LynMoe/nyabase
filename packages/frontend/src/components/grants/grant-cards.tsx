import { Plus } from 'lucide-react';
import {
  formatGpuGrantSummary,
  type GrantExpiryPhase,
  type ServerDto,
  type ServerGrantDto,
  type SharedBackendDto,
  type SharedBackendGrantDto,
  type StoragePoolDto,
  type StoragePoolGrantDto,
} from '@nyabase/common';
import { grantExpiryPhaseLabel } from '../../lib/display-labels.js';
import { formatGrantBytes, formatGrantQuotaLine } from '../../lib/grant-quota.js';
import { SectionCard } from '../layout/section-card.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Hint } from '../ui/hint.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { truncateId } from '../refs/technical-id.js';
import {
  backendDisplayName,
  backendName,
  expiryLabel,
  expiryPhase,
  poolName,
  serverName,
} from './use-grant-panel-data.js';

export const GRANT_MERGE_NOTE = '多条授权逐项取最大：同一用户在同一资源上的直接授权与所属各用户组的授权合并，额度取最大值（任一为不限则不限），GPU 白名单取并集，到期取最晚（任一不设期限则不过期）。';

export type GrantResource = 'server-grants' | 'storage-pool-grants' | 'shared-backend-grants';

/** A grant picked for deletion, awaiting confirmation. */
export interface DeleteTarget {
  resource: GrantResource;
  id: string;
  label: string;
}

/** "+ 授权" that says up front when there is nothing left to grant, instead of opening an empty dialog. */
function AddGrantButton({ blocked, onClick, testId }: { blocked: string | null; onClick: () => void; testId: string }) {
  return (
    <Hint content={blocked} disabled={blocked !== null}>
      <Button size="sm" onClick={onClick} disabled={blocked !== null} data-testid={testId}>
        <Plus className="h-4 w-4" />授权
      </Button>
    </Hint>
  );
}

function PhaseBadge({ phase }: { phase: GrantExpiryPhase }) {
  return (
    <Badge variant={phase === 'lost' ? 'destructive' : phase === 'grace' ? 'warning' : 'outline'}>
      {grantExpiryPhaseLabel(phase)}
    </Badge>
  );
}

function GrantRowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="outline" onClick={onEdit}>编辑</Button>
      <Button size="sm" variant="ghost" onClick={onDelete}>删除</Button>
    </div>
  );
}

function GrantTableHead({ first, second }: { first: string; second: string }) {
  return (
    <TableHeader>
      <TableRow>
        <TableHead>{first}</TableHead>
        <TableHead>{second}</TableHead>
        <TableHead>到期</TableHead>
        <TableHead>状态</TableHead>
        <TableHead className="text-right">操作</TableHead>
      </TableRow>
    </TableHeader>
  );
}

/** Servers whose access lapsed: stopped now, purged when the grace ends. */
export function GraceCard({
  lapsed,
  servers,
}: {
  lapsed: Array<{ serverId: string; purgeAt?: string | null }>;
  servers: ServerDto[];
}) {
  if (lapsed.length === 0) return null;
  return (
    <SectionCard title="宽限中的服务器" testId="grant-grace">
      <ul className="space-y-1 text-sm">
        {lapsed.map((lapse) => (
          <li key={lapse.serverId}>
            <ResourceRef
              kind="server"
              id={lapse.serverId}
              name={servers.find((item) => item.id === lapse.serverId)?.name}
            />
            {' '}已失去访问覆盖，容器已停止；{lapse.purgeAt ? expiryLabel(lapse.purgeAt) : '宽限期满'} 起清除其容器与数据卷。重新授权可取消清除（已停止的容器不会自动启动）。
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

export function ServerGrantsCard({
  grants,
  servers,
  blocked,
  onAdd,
  onEdit,
  onDelete,
}: {
  grants: ServerGrantDto[];
  servers: ServerDto[];
  blocked: string | null;
  onAdd: () => void;
  onEdit: (grant: ServerGrantDto) => void;
  onDelete: (target: DeleteTarget) => void;
}) {
  return (
    <SectionCard
      title="服务器授权"
      description={GRANT_MERGE_NOTE}
      actions={<AddGrantButton blocked={blocked} onClick={onAdd} testId="grant-add-server" />}
      flush={grants.length > 0}
      testId="grant-servers"
    >
      {grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无服务器授权。</p>
      ) : (
        <Table className="min-w-[720px]">
          <GrantTableHead first="服务器" second="额度" />
          <TableBody>
            {grants.map((grant) => {
              const server = servers.find((item) => item.id === grant.serverId);
              const quotaLine = formatGrantQuotaLine(grant, formatGpuGrantSummary(grant.gpuPciAddresses));
              return (
                <TableRow key={grant.id}>
                  <TableCell className="whitespace-normal">
                    <ResourceRef kind="server" id={grant.serverId} name={server?.name} />
                  </TableCell>
                  <TableCell className="whitespace-normal">{quotaLine}</TableCell>
                  <TableCell>{expiryLabel(grant.expiresAt)}</TableCell>
                  <TableCell><PhaseBadge phase={expiryPhase(grant.expiresAt)} /></TableCell>
                  <TableCell className="text-right">
                    <GrantRowActions
                      onEdit={() => onEdit(grant)}
                      onDelete={() => onDelete({
                        resource: 'server-grants',
                        id: grant.serverId,
                        label: `${server?.name ?? truncateId(grant.serverId)} · ${quotaLine} · 到期 ${expiryLabel(grant.expiresAt)}`,
                      })}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

export function PoolGrantsCard({
  grants,
  pools,
  servers,
  grantedServerIds,
  blocked,
  onAdd,
  onEdit,
  onDelete,
}: {
  grants: StoragePoolGrantDto[];
  pools: StoragePoolDto[];
  servers: ServerDto[];
  grantedServerIds: ReadonlySet<string>;
  blocked: string | null;
  onAdd: () => void;
  onEdit: (grant: StoragePoolGrantDto) => void;
  onDelete: (target: DeleteTarget) => void;
}) {
  const isOrphan = (grant: StoragePoolGrantDto): boolean => {
    const pool = pools.find((item) => item.id === grant.poolId);
    return !pool || !grantedServerIds.has(pool.serverId);
  };
  return (
    <SectionCard
      title="存储池授权"
      description={
        grants.some(isOrphan)
          ? '只能授权已有服务器授权的机器上的存储池。存储池（无服务器授权）仍会列在表中，需先补上对应服务器授权。'
          : undefined
      }
      actions={<AddGrantButton blocked={blocked} onClick={onAdd} testId="grant-add-pool" />}
      flush={grants.length > 0}
      testId="grant-pools"
    >
      {grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无存储池授权。</p>
      ) : (
        <Table className="min-w-[720px]">
          <GrantTableHead first="存储池" second="服务器" />
          <TableBody>
            {grants.map((grant) => {
              const pool = pools.find((item) => item.id === grant.poolId);
              return (
                <TableRow key={grant.id}>
                  <TableCell className="whitespace-normal">
                    <div className="space-y-1">
                      <ResourceRef kind="pool" id={grant.poolId} name={pool ? (pool.displayName ?? pool.incusName) : undefined} />
                      {isOrphan(grant) ? <Badge variant="warning">无服务器授权</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {pool ? (
                      <ResourceRef kind="server" id={pool.serverId} name={serverName(pool.serverId, servers)} />
                    ) : '—'}
                  </TableCell>
                  <TableCell>{expiryLabel(grant.expiresAt)}</TableCell>
                  <TableCell><PhaseBadge phase={expiryPhase(grant.expiresAt)} /></TableCell>
                  <TableCell className="text-right">
                    <GrantRowActions
                      onEdit={() => onEdit(grant)}
                      onDelete={() => onDelete({
                        resource: 'storage-pool-grants',
                        id: grant.poolId,
                        label: `${poolName(grant.poolId, pools, servers)} · 到期 ${expiryLabel(grant.expiresAt)}`,
                      })}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

export function BackendGrantsCard({
  grants,
  backends,
  blocked,
  onAdd,
  onEdit,
  onDelete,
}: {
  grants: SharedBackendGrantDto[];
  backends: SharedBackendDto[];
  blocked: string | null;
  onAdd: () => void;
  onEdit: (grant: SharedBackendGrantDto) => void;
  onDelete: (target: DeleteTarget) => void;
}) {
  return (
    <SectionCard
      title="共享存储授权"
      actions={<AddGrantButton blocked={blocked} onClick={onAdd} testId="grant-add-backend" />}
      flush={grants.length > 0}
      testId="grant-backends"
    >
      {grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无共享存储授权。</p>
      ) : (
        <Table className="min-w-[720px]">
          <GrantTableHead first="共享存储" second="额度" />
          <TableBody>
            {grants.map((grant) => (
              <TableRow key={grant.id}>
                <TableCell className="whitespace-normal">
                  <ResourceRef
                    kind="shared-backend"
                    id={grant.sharedBackendId}
                    name={backendDisplayName(grant.sharedBackendId, backends)}
                  />
                </TableCell>
                <TableCell>{formatGrantBytes(grant.limitBytes)}</TableCell>
                <TableCell>{expiryLabel(grant.expiresAt)}</TableCell>
                <TableCell><PhaseBadge phase={expiryPhase(grant.expiresAt)} /></TableCell>
                <TableCell className="text-right">
                  <GrantRowActions
                    onEdit={() => onEdit(grant)}
                    onDelete={() => onDelete({
                      resource: 'shared-backend-grants',
                      id: grant.sharedBackendId,
                      label: `${backendName(grant.sharedBackendId, backends)} · ${formatGrantBytes(grant.limitBytes)} · 到期 ${expiryLabel(grant.expiresAt)}`,
                    })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
