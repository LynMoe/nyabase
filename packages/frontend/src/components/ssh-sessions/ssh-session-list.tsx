import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import type { CursorPaginatedResponse, ListScope, SshSessionDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import {
  formatDuration,
  formatShortTime,
  sshHistoryLabel,
  sshSessionsPath,
  totalCount,
  type SshSessionFilters,
} from '../../lib/ssh-sessions.js';
import { formatBytes } from '../../lib/utils.js';
import { useCursorPages } from '../../hooks/use-cursor-pages.js';
import { SegmentedFilter } from '../layout/list-search.js';
import { QueryView } from '../layout/query-view.js';
import { SectionCard } from '../layout/section-card.js';
import { Badge } from '../ui/badge.js';
import { Input } from '../ui/input.js';
import { Pagination } from '../ui/pagination.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { SshSessionDetailDialog } from './ssh-session-detail-dialog.js';

const PAGE_SIZES = [20, 50, 100] as const;
const STATES = [
  { value: 'any', label: '全部' },
  { value: 'open', label: '在线' },
  { value: 'closed', label: '已结束' },
] as const;
type StateFilter = (typeof STATES)[number]['value'];

/**
 * Connection history through the SSH proxy: one row per connection, each
 * with the containers it reached; a row opens the channel details.
 */
export function SshSessionList({
  scope,
  containerId,
  title = '连接历史',
  description,
  showUser = scope === 'all',
  showPeerFilter = scope === 'all',
  defaultPageSize = 20,
}: {
  scope: ListScope;
  containerId?: string;
  title?: string;
  description?: string;
  showUser?: boolean;
  showPeerFilter?: boolean;
  defaultPageSize?: (typeof PAGE_SIZES)[number];
}) {
  const [state, setState] = useState<StateFilter>('any');
  const [peerIp, setPeerIp] = useState('');
  const [pageSize, setPageSize] = useState<number>(defaultPageSize);
  const [selected, setSelected] = useState<string | null>(null);
  const filters: SshSessionFilters = {
    containerId,
    state: state === 'any' ? undefined : state,
    peerIp: /^[0-9a-fA-F.:]+$/.test(peerIp.trim()) ? peerIp.trim() : undefined,
  };
  const pages = useCursorPages(JSON.stringify([scope, filters, pageSize]));
  const sessionsQuery = useQuery({
    queryKey: queryKeys.sshSessions.list(scope, filters, pageSize, pages.cursor),
    queryFn: () => api.get<CursorPaginatedResponse<SshSessionDto>>(
      sshSessionsPath(scope, filters, { limit: pageSize, cursor: pages.cursor }),
    ),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const turning = sessionsQuery.isPlaceholderData;

  return (
    <>
      <SectionCard
        title={title}
        description={description}
        testId="ssh-session-list"
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedFilter label="状态" value={state} options={STATES} onChange={setState} />
            {showPeerFilter ? (
              <Input
                className="h-9 w-[200px]"
                placeholder="来源 IP"
                aria-label="来源 IP"
                value={peerIp}
                onChange={(event) => setPeerIp(event.target.value)}
              />
            ) : null}
          </div>
        }
        flush
      >
        <QueryView query={sessionsQuery} resourceName="SSH 连接历史" loadingLabel="加载 SSH 连接历史...">
          {(data) => data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <History className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm font-medium">{pages.page > 0 ? '这一页已没有连接。' : '还没有 SSH 连接记录。'}</p>
            </div>
          ) : (
            <div className={turning ? 'opacity-60 transition-opacity' : undefined} aria-busy={turning}>
              <SshSessionTable items={data.items} showUser={showUser} onSelect={setSelected} />
            </div>
          )}
        </QueryView>
      </SectionCard>
      {sessionsQuery.data && (pages.page > 0 || sessionsQuery.data.nextCursor != null) ? (
        <Pagination
          page={pages.page}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          hasNext={sessionsQuery.data.nextCursor != null}
          busy={turning}
          onPageChange={(next) => {
            if (next < pages.page) pages.previous();
            else pages.next(sessionsQuery.data?.nextCursor);
          }}
          onPageSizeChange={setPageSize}
        />
      ) : null}
      <SshSessionDetailDialog
        scope={scope}
        sessionId={selected}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
      />
    </>
  );
}

function SshSessionTable({
  items,
  showUser,
  onSelect,
}: {
  items: SshSessionDto[];
  showUser: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <Table className="min-w-[780px]">
      <TableHeader>
        <TableRow>
          {showUser ? <TableHead>用户</TableHead> : null}
          <TableHead>来源</TableHead>
          <TableHead>连到的容器</TableHead>
          <TableHead>时间</TableHead>
          <TableHead>流量（上行 / 下行）</TableHead>
          <TableHead>状态</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((session) => {
          const rejected = totalCount(session.rejectedRequests);
          return (
            <TableRow
              key={session.id}
              className="cursor-pointer"
              data-testid="ssh-session-row"
              onClick={() => onSelect(session.id)}
            >
              {showUser ? (
                <TableCell>
                  <div className="font-medium text-foreground">{session.username}</div>
                  {session.login !== session.username ? (
                    <div className="text-xs text-muted-foreground">登录名 {session.login}</div>
                  ) : null}
                </TableCell>
              ) : null}
              <TableCell>
                <div className="font-mono text-xs">{session.peer}</div>
                {session.clientVersion ? (
                  <div className="max-w-[180px] truncate text-xs text-muted-foreground" title={session.clientVersion}>
                    {session.clientVersion}
                  </div>
                ) : null}
              </TableCell>
              <TableCell>
                {session.targets.length > 0 ? (
                  <div className="flex max-w-[260px] flex-wrap gap-1">
                    {session.targets.map((target) => (
                      <Badge
                        key={target.containerId}
                        variant="outline"
                        className="max-w-[240px] truncate font-normal"
                        title={`${target.serverSlug}.${target.containerName}`}
                      >
                        {target.serverSlug}.{target.containerName}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">没有打开通道</span>
                )}
              </TableCell>
              <TableCell>
                <div className="whitespace-nowrap tabular-nums">{formatShortTime(session.connectedAt)}</div>
                <div className="text-xs text-muted-foreground">
                  {session.closedAt ? '持续' : '已在线'} {formatDuration(session.connectedAt, session.closedAt)}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">
                {formatBytes(session.bytesFromClient)} / {formatBytes(session.bytesToClient)}
              </TableCell>
              <TableCell>
                {session.closedAt ? (
                  <Badge variant={session.closeReason === 'lost' || session.closeReason === 'revoked' ? 'warning' : 'secondary'}>
                    {sshHistoryLabel(session.closeReason ?? 'closed')}
                  </Badge>
                ) : (
                  <Badge variant="success">在线</Badge>
                )}
                {rejected > 0 ? (
                  <div className="mt-1 text-xs text-muted-foreground">被拒请求 {rejected} 次</div>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
