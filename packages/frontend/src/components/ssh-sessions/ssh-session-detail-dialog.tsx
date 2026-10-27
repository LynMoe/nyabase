import { useQuery } from '@tanstack/react-query';
import type { ListScope, SshSessionDetailDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  formatDuration,
  formatShortTime,
  formatTime,
  sortedCounts,
  sshHistoryLabel,
  sshSessionPath,
} from '../../lib/ssh-sessions.js';
import { formatBytes } from '../../lib/utils.js';
import { QueryView } from '../layout/query-view.js';
import { TechnicalId } from '../refs/technical-id.js';
import { Badge } from '../ui/badge.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';

/** One connection: who, from where, with which key, and every channel it opened or was refused. */
export function SshSessionDetailDialog({
  scope,
  sessionId,
  onOpenChange,
}: {
  scope: ListScope;
  sessionId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const detailQuery = useQuery({
    queryKey: queryKeys.sshSessions.detail(scope, sessionId ?? ''),
    queryFn: () => api.get<SshSessionDetailDto>(sshSessionPath(scope, sessionId!)),
    enabled: sessionId !== null,
  });
  return (
    <Dialog open={sessionId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl" data-testid="ssh-session-detail">
        <DialogHeader>
          <DialogTitle>SSH 连接详情</DialogTitle>
        </DialogHeader>
        <QueryView query={detailQuery} resourceName="SSH 连接" loadingLabel="加载 SSH 连接...">
          {(session) => <SessionDetail session={session} />}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}

function SessionDetail({ session }: { session: SshSessionDetailDto }) {
  const rejected = sortedCounts(session.rejectedRequests);
  return (
    <div className="max-h-[70vh] space-y-4 overflow-y-auto">
      <div className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-3">
        <Field label="用户" value={session.login === session.username ? session.username : `${session.username}（登录名 ${session.login}）`} />
        <Field label="来源" value={session.peer} mono />
        <Field label="客户端" value={session.clientVersion ?? '未知'} />
        <div className="min-w-0 sm:col-span-2">
          <p className="text-xs text-muted-foreground">公钥（{session.keyAlgorithm}）</p>
          <div className="mt-1"><TechnicalId label="公钥指纹" value={session.keyFingerprint} kind="opaque" /></div>
        </div>
        <Field
          label="登录名指定的容器"
          value={session.pinned ? `${session.pinned.serverSlug}.${session.pinned.containerName}` : '无'}
        />
        <Field label="连接时间" value={formatTime(session.connectedAt)} />
        <Field
          label={session.closedAt ? '结束' : '状态'}
          value={session.closedAt
            ? `${formatTime(session.closedAt)}（${sshHistoryLabel(session.closeReason ?? 'closed')}）`
            : `在线，最近上报 ${formatTime(session.lastSeenAt)}`}
        />
        <Field label="时长" value={formatDuration(session.connectedAt, session.closedAt)} />
        <Field label="上行（客户端 → 容器）" value={formatBytes(session.bytesFromClient)} />
        <Field label="下行（容器 → 客户端）" value={formatBytes(session.bytesToClient)} />
        <Field label="通道" value={`打开 ${session.channelsOpened} 个，被拒 ${session.channelsRejected} 个`} />
      </div>

      {rejected.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">被拒绝的请求</p>
          <div className="flex flex-wrap gap-1.5">
            {rejected.map(([kind, count]) => (
              <Badge key={kind} variant="outline" className="font-normal">
                {sshHistoryLabel(kind)} × {count}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[680px]">
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>请求的目标</TableHead>
              <TableHead>容器</TableHead>
              <TableHead>结果</TableHead>
              <TableHead>时间</TableHead>
              <TableHead>流量（上行 / 下行）</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {session.channels.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">这条连接没有请求过通道</TableCell>
              </TableRow>
            ) : session.channels.map((channel) => (
              <TableRow key={channel.seq} data-testid="ssh-session-channel">
                <TableCell className="tabular-nums">{channel.seq}</TableCell>
                <TableCell>
                  <div className="font-mono text-xs">{channel.targetHost}:{channel.targetPort}</div>
                  <div className="text-xs text-muted-foreground">发起端 {channel.originator}</div>
                </TableCell>
                <TableCell>
                  {channel.route ? (
                    <>
                      <div className="max-w-[220px] truncate" title={`${channel.route.serverSlug}.${channel.route.containerName}`}>
                        {channel.route.serverSlug}.{channel.route.containerName}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">{channel.route.routedIp}</div>
                    </>
                  ) : <span className="text-muted-foreground">-</span>}
                </TableCell>
                <TableCell>
                  {channel.result === 'opened' ? (
                    channel.closedAt
                      ? <Badge variant="secondary">{sshHistoryLabel(channel.closeReason ?? 'closed')}</Badge>
                      : <Badge variant="success">打开中</Badge>
                  ) : (
                    <Badge variant="destructive">{sshHistoryLabel(channel.result)}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="whitespace-nowrap tabular-nums">{formatShortTime(channel.openedAt)}</div>
                  {channel.result === 'opened' ? (
                    <div className="text-xs text-muted-foreground">{formatDuration(channel.openedAt, channel.closedAt)}</div>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {channel.result === 'opened'
                    ? `${formatBytes(channel.bytesFromClient)} / ${formatBytes(channel.bytesToClient)}`
                    : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {session.unrecordedRejectedChannels > 0 ? (
        <p className="text-xs text-muted-foreground">
          另有 {session.unrecordedRejectedChannels} 个被拒的通道只计了数，没有逐条记录。
        </p>
      ) : null}
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</p>
    </div>
  );
}
