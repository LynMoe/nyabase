import { Link } from '@tanstack/react-router';
import { GRANT_EXPIRY_GRACE_DAYS, type GrantBundlePreviewDto, type GrantBundlePreviewEntryDto } from '@nyabase/common';
import { truncateId } from '../../components/refs/technical-id.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { poolDisplayName } from '../../lib/data-disks.js';
import { GRANT_FIELD_LABELS, formatQuotaValue } from '../../lib/grant-bundle-form.js';
import { diffDataDisks, formatDiskCap } from '../../lib/grant-data-disks.js';
import { useServerPools } from '../../lib/server-queries.js';
import { formatBytes } from '../../lib/utils.js';

type NameOf = (poolId: string) => string;

/** What the proposed values ask for beyond what the server has. */
export function capacityWarnings(preview: GrantBundlePreviewDto): string[] {
  const { proposed, serverCpuCores, serverGpuCount } = preview;
  const warnings: string[] = [];
  if (proposed.cpuCores !== null && serverCpuCores !== null && proposed.cpuCores > serverCpuCores) {
    warnings.push(`服务器只有 ${serverCpuCores} 个可分配的 CPU，CPU ${proposed.cpuCores} 核超出部分不会生效。`);
  }
  if (proposed.gpuCount !== null && proposed.gpuCount > serverGpuCount) {
    warnings.push(`服务器只有 ${serverGpuCount} 张 GPU，每个用户最多分到 ${serverGpuCount} 张。`);
  }
  return warnings;
}

/** What the change does to one user's running resources and data. */
export function entryWarnings(entry: GrantBundlePreviewEntryDto, nameOf: NameOf = (id) => id): string[] {
  const warnings: string[] = [];
  if (entry.memBytesInUse !== null) {
    warnings.push(`运行中的容器共占用内存 ${formatBytes(entry.memBytesInUse)}，超出新额度：降到额度内之前不能再启动容器或调大内存。`);
  }
  if (entry.rootDiskBytesInUse !== null) {
    warnings.push(`系统盘共 ${formatBytes(entry.rootDiskBytesInUse)}，超出新的系统盘上限：降到上限内之前不能新建容器或扩容系统盘。`);
  }
  if (entry.diskBytesInUse !== null) {
    warnings.push(`系统盘与数据盘上的数据共 ${formatBytes(entry.diskBytesInUse)}，超出新的磁盘总额：数据盘只能删除不能再写，也不能新建容器或扩容系统盘。`);
  }
  if (entry.dataDisksRevoked.length > 0) {
    warnings.push(`${entry.dataDisksRevoked.map(nameOf).join('、')} 不再在授权内：其上的数据卷立即从所有容器卸载，${GRANT_EXPIRY_GRACE_DAYS} 天后删除。`);
  }
  for (const disk of entry.dataDisksOverCap) {
    warnings.push(`${nameOf(disk.poolId)} 上已有数据 ${formatBytes(disk.usedBytes)}，超出新上限 ${formatBytes(disk.capBytes)}：超出部分只能删除。`);
  }
  if (entry.gpusInUseRemoved.length > 0) {
    warnings.push(`容器占用的 GPU ${entry.gpusInUseRemoved.join(', ')} 不再在授权内，这些容器下次启动会失败。`);
  }
  return warnings;
}

/** The bundle's own data-disk list change: added, removed and re-capped disks. */
function DataDiskListChange({ preview, nameOf }: { preview: GrantBundlePreviewDto; nameOf: NameOf }) {
  const diff = diffDataDisks(preview.bundle.dataDisks, preview.proposed.dataDisks);
  if (diff.added.length + diff.removed.length + diff.capChanged.length === 0) return null;
  return (
    <section className="space-y-1 rounded-md border p-3 text-sm" data-testid="grant-bundle-preview-disks">
      <h3 className="font-medium">数据盘变化</h3>
      <ul className="space-y-1">
        {diff.added.map((disk) => (
          <li key={`add-${disk.poolId}`}>
            新增 {nameOf(disk.poolId)}（{formatDiskCap(disk.capBytes)}）：跟随模板的用户自动建卷并挂载到容器。
          </li>
        ))}
        {diff.removed.map((disk) => (
          <li key={`remove-${disk.poolId}`} className="text-destructive">
            移除 {nameOf(disk.poolId)}：跟随模板的用户在其上的数据卷立即卸载，{GRANT_EXPIRY_GRACE_DAYS} 天后删除。
          </li>
        ))}
        {diff.capChanged.map((change) => (
          <li key={`cap-${change.poolId}`}>
            {nameOf(change.poolId)} 上限 {formatDiskCap(change.before)} → {formatDiskCap(change.after)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function UserCell({ entry }: { entry: GrantBundlePreviewEntryDto }) {
  return (
    <TableCell className="whitespace-normal">
      <Link to="/users/$id" params={{ id: entry.userId }} className="block min-w-0">
        <p className="font-medium">{entry.displayName}</p>
        <p className="font-mono text-xs text-muted-foreground">@{entry.username}</p>
      </Link>
    </TableCell>
  );
}

/** Who a proposed bundle change reaches: changed users (with warnings), users whose overrides shield them, server limits. */
export function BundlePreview({ preview }: { preview: GrantBundlePreviewDto }) {
  const pools = useServerPools(preview.bundle.serverId).data ?? [];
  const nameOf: NameOf = (poolId) => {
    const pool = pools.find((row) => row.id === poolId);
    return pool ? poolDisplayName(pool) : truncateId(poolId);
  };
  const affected = preview.entries.filter((entry) => entry.changes.length > 0 || entry.dataDisks === 'follows'
    || entryWarnings(entry).length > 0);
  const shielded = preview.entries.filter((entry) => entry.overridden.length > 0 || entry.dataDisks === 'overridden');
  const capacity = capacityWarnings(preview);
  return (
    <div className="max-h-[60vh] space-y-4 overflow-y-auto" data-testid="grant-bundle-preview-result">
      {capacity.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>超出服务器容量</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">{capacity.map((text) => <li key={text}>{text}</li>)}</ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <DataDiskListChange preview={preview} nameOf={nameOf} />
      <section className="space-y-2">
        <h3 className="text-sm font-medium">立即变化（{affected.length} 个用户）</h3>
        {affected.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有用户的有效额度会因此变化。</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>变化</TableHead>
                  <TableHead>影响</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {affected.map((entry) => {
                  const warnings = entryWarnings(entry, nameOf);
                  return (
                    <TableRow key={entry.grantId}>
                      <UserCell entry={entry} />
                      <TableCell className="whitespace-normal">
                        <ul className="space-y-0.5 text-sm tabular-nums">
                          {entry.changes.map((change) => (
                            <li key={change.field}>
                              {GRANT_FIELD_LABELS[change.field]} {formatQuotaValue(change.field, change.before)}
                              {' → '}{formatQuotaValue(change.field, change.after)}
                            </li>
                          ))}
                          {entry.dataDisks === 'follows' ? <li>{GRANT_FIELD_LABELS.dataDisks} 随模板变化</li> : null}
                        </ul>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {warnings.length === 0 ? <span className="text-muted-foreground">—</span> : (
                          <ul className="space-y-1 text-sm text-warning">{warnings.map((text) => <li key={text}>{text}</li>)}</ul>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      {shielded.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">已覆盖、不受影响（{shielded.length} 个用户）</h3>
          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-[480px]">
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>保持的覆盖值</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shielded.map((entry) => (
                  <TableRow key={entry.grantId}>
                    <UserCell entry={entry} />
                    <TableCell className="whitespace-normal">
                      <ul className="space-y-0.5 text-sm tabular-nums">
                        {entry.overridden.map((item) => (
                          <li key={item.field}>{GRANT_FIELD_LABELS[item.field]} {formatQuotaValue(item.field, item.value)}</li>
                        ))}
                        {entry.dataDisks === 'overridden' ? <li>{GRANT_FIELD_LABELS.dataDisks} 自己的列表</li> : null}
                      </ul>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
