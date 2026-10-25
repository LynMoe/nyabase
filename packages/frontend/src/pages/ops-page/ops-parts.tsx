import { useQuery } from '@tanstack/react-query';
import { type IntentDto, IntentKind, IntentResourceType, type ServerDto } from '@nyabase/common';
import { SegmentedFilter } from '../../components/layout/list-search.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  failureCodeLabel,
  intentKindLabel,
  intentResourceTypeLabel,
  intentStatusLabel,
} from '../../lib/status-labels.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { IntentResourceName, IntentServerRef } from '../../components/intents/intent-detail-dialog.js';
import { ResourceRef } from '../../components/refs/resource-ref.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { intentPending } from '../../lib/in-progress.js';
import { formatIntentAttempt, statusBadgeVariant } from '../../lib/intent-visibility.js';

const ALL = '__all__';
export const SEGMENTS = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '进行中' },
  { value: 'failed', label: '失败' },
] as const;

export type StatusSegment = (typeof SEGMENTS)[number]['value'];

export interface IntentFilterState {
  segment: StatusSegment;
  kind?: IntentKind;
  resourceType?: IntentResourceType;
  serverId?: string;
}

export function IntentFilters({
  filters: { segment, kind, resourceType, serverId },
  onChange,
  showServerFilter,
}: {
  filters: IntentFilterState;
  onChange: (change: Partial<IntentFilterState>) => void;
  showServerFilter: boolean;
}) {
  const servers = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
    enabled: showServerFilter,
  }).data ?? [];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedFilter
        label="状态"
        value={segment}
        options={SEGMENTS}
        onChange={(value) => onChange({ segment: value })}
      />
      <Select
        value={kind ?? ALL}
        onValueChange={(value) => onChange({ kind: value === ALL ? undefined : value as IntentKind })}
      >
        <SelectTrigger className="h-9 w-[160px]" aria-label="操作类型">
          <SelectValue placeholder="全部类型" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部类型</SelectItem>
          {Object.values(IntentKind).map((value) => (
            <SelectItem key={value} value={value}>{intentKindLabel(value)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={resourceType ?? ALL}
        onValueChange={(value) => onChange({ resourceType: value === ALL ? undefined : value as IntentResourceType })}
      >
        <SelectTrigger className="h-9 w-[160px]" aria-label="资源类型">
          <SelectValue placeholder="全部资源" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部资源</SelectItem>
          {Object.values(IntentResourceType).map((value) => (
            <SelectItem key={value} value={value}>{intentResourceTypeLabel(value)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {showServerFilter && (
        <Select
          value={serverId ?? ALL}
          onValueChange={(value) => onChange({ serverId: value === ALL ? undefined : value })}
        >
          <SelectTrigger className="h-9 w-[180px]" aria-label="服务器">
            <SelectValue placeholder="全部服务器" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部服务器</SelectItem>
            {servers.map((server) => (
              <SelectItem key={server.id} value={server.id}>{server.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export function IntentsTable({
  items,
  linkServers,
  onSelect,
}: {
  items: IntentDto[];
  linkServers: boolean;
  onSelect: (intent: IntentDto) => void;
}) {
  return (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>资源类型</TableHead>
                <TableHead>资源名称</TableHead>
                <TableHead>服务器</TableHead>
                <TableHead>请求人</TableHead>
                <TableHead>尝试</TableHead>
                <TableHead>失败码</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((intent) => (
                <TableRow
                  key={intent.id}
                  className="cursor-pointer"
                  onClick={() => onSelect(intent)}
                >
                  <TableCell>{new Date(intent.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{intentKindLabel(intent.kind)}</TableCell>
                  <TableCell>
                    <StatusBadge
                      label={intentStatusLabel(intent.status)}
                      raw={intent.status}
                      pending={intentPending(intent.status)}
                      variant={statusBadgeVariant(intent.status)}
                    />
                  </TableCell>
                  <TableCell>{intentResourceTypeLabel(intent.resourceType)}</TableCell>
                  <TableCell title={intent.resourceId}>
                    <IntentResourceName intent={intent} />
                  </TableCell>
                  <TableCell>
                    <IntentServerRef serverId={intent.serverId} link={linkServers} />
                  </TableCell>
                  <TableCell>
                    {intent.requestedBy
                      ? <ResourceRef kind="user" id={intent.requestedBy} />
                      : '系统'}
                  </TableCell>
                  <TableCell>{formatIntentAttempt(intent)}</TableCell>
                  <TableCell>{failureCodeLabel(intent.failureCode) ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
  );
}
