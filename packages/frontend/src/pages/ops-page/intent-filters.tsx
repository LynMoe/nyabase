import { useQuery } from '@tanstack/react-query';
import { IntentKind, IntentResourceType, type ServerDto } from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { intentKindLabel, intentResourceTypeLabel } from '../../lib/status-labels.js';

const ALL = '__all__';
export const SEGMENTS = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '进行中' },
  { id: 'failed', label: '失败' },
] as const;

export type StatusSegment = (typeof SEGMENTS)[number]['id'];

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
      <div className="flex flex-wrap rounded-md bg-muted p-1">
        {SEGMENTS.map((item) => (
          <Button
            key={item.id}
            type="button"
            size="sm"
            variant={segment === item.id ? 'secondary' : 'ghost'}
            className="h-8"
            onClick={() => onChange({ segment: item.id })}
          >
            {item.label}
          </Button>
        ))}
      </div>
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
