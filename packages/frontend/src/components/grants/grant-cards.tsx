import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  formatGpuGrantSummary,
  type GrantExpiryPhase,
  type ServerGrantDto,
  type SharedBackendGrantDto,
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
import { BackendGrantDialog, PoolGrantDialog, ServerGrantDialog } from './grant-dialogs.js';
import {
  backendDisplayName,
  backendName,
  expiryLabel,
  expiryPhase,
  grantablePools,
  type GrantSubject,
  poolName,
  serverName,
  useGrantBackends,
  useGrantPools,
  useGrantServers,
  useLapsedServers,
  useSubjectGrants,
} from './use-grant-panel-data.js';

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
export function GraceCard({ subject }: { subject: GrantSubject }) {
  const lapsed = useLapsedServers(subject);
  const servers = useGrantServers().data ?? [];
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
            {' '}宽限中 · {expiryLabel(lapse.purgeAt)} 清除
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

export function ServerGrantsCard({
  subject,
  onDelete,
}: {
  subject: GrantSubject;
  onDelete: (target: DeleteTarget) => void;
}) {
  const serversQuery = useGrantServers();
  const servers = serversQuery.data ?? [];
  const grants = useSubjectGrants(subject, 'servers').data ?? [];
  // 'add' opens an empty dialog, a grant opens its editor.
  const [dialog, setDialog] = useState<'add' | ServerGrantDto | null>(null);
  const grantedIds = new Set(grants.map((row) => row.serverId));
  const blocked = !serversQuery.isSuccess
    ? null
    : servers.length === 0
      ? '还没有服务器'
      : servers.every((server) => grantedIds.has(server.id)) ? '所有服务器都已授权。' : null;
  return (
    <SectionCard
      title="服务器授权"
      actions={<AddGrantButton blocked={blocked} onClick={() => setDialog('add')} testId="grant-add-server" />}
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
                      onEdit={() => setDialog(grant)}
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
      {dialog ? (
        <ServerGrantDialog
          subject={subject}
          grant={dialog === 'add' ? undefined : dialog}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </SectionCard>
  );
}

export function PoolGrantsCard({
  subject,
  onDelete,
}: {
  subject: GrantSubject;
  onDelete: (target: DeleteTarget) => void;
}) {
  const serversQuery = useGrantServers();
  const poolsQuery = useGrantPools();
  const servers = serversQuery.data ?? [];
  const pools = poolsQuery.data ?? [];
  const grants = useSubjectGrants(subject, 'pools').data ?? [];
  const serverGrants = useSubjectGrants(subject, 'servers').data ?? [];
  const [dialog, setDialog] = useState<'add' | StoragePoolGrantDto | null>(null);
  const grantedServerIds = new Set(serverGrants.map((row) => row.serverId));
  const blocked = serverGrants.length === 0
    ? '请先添加服务器授权。'
    : poolsQuery.isSuccess && grantablePools(pools, grantedServerIds, grants).length === 0
      ? '已授权服务器上没有其他可授权的存储池。'
      : null;
  const isOrphan = (grant: StoragePoolGrantDto): boolean => {
    const pool = pools.find((item) => item.id === grant.poolId);
    return !pool || !grantedServerIds.has(pool.serverId);
  };
  return (
    <SectionCard
      title="存储池授权"
      actions={<AddGrantButton blocked={blocked} onClick={() => setDialog('add')} testId="grant-add-pool" />}
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
                      onEdit={() => setDialog(grant)}
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
      {dialog ? (
        <PoolGrantDialog
          subject={subject}
          grant={dialog === 'add' ? undefined : dialog}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </SectionCard>
  );
}

export function BackendGrantsCard({
  subject,
  onDelete,
}: {
  subject: GrantSubject;
  onDelete: (target: DeleteTarget) => void;
}) {
  const backendsQuery = useGrantBackends();
  const backends = backendsQuery.data ?? [];
  const grants = useSubjectGrants(subject, 'backends').data ?? [];
  const [dialog, setDialog] = useState<'add' | SharedBackendGrantDto | null>(null);
  const grantedIds = new Set(grants.map((row) => row.sharedBackendId));
  const blocked = !backendsQuery.isSuccess
    ? null
    : backends.length === 0
      ? '还没有登记共享存储。'
      : backends.every((backend) => grantedIds.has(backend.id)) ? '所有共享存储都已授权。' : null;
  return (
    <SectionCard
      title="共享存储授权"
      actions={<AddGrantButton blocked={blocked} onClick={() => setDialog('add')} testId="grant-add-backend" />}
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
                    onEdit={() => setDialog(grant)}
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
      {dialog ? (
        <BackendGrantDialog
          subject={subject}
          grant={dialog === 'add' ? undefined : dialog}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </SectionCard>
  );
}
