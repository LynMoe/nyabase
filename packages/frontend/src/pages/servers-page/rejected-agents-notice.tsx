import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import type { RejectedAgentCredentialDto, ServerDto } from '@nyabase/common';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { relativeTime } from '../../lib/utils.js';

/**
 * Host agents the Backend turns away: after a database restore, hosts
 * enrolled after the backup claim server ids this database does not know;
 * a stale agent after a re-enrollment presents an outdated credential.
 * Either way the host needs a fresh enrollment token.
 */
export function RejectedAgentsNotice({ servers }: { servers: ServerDto[] | undefined }) {
  const query = useQuery({
    queryKey: queryKeys.servers.rejectedAgents,
    queryFn: () => api.get<RejectedAgentCredentialDto[]>('/admin/agent-rejections'),
    refetchInterval: 60_000,
  });
  const rejected = query.data ?? [];
  if (rejected.length === 0) return null;
  return (
    <Alert variant="warning" data-testid="rejected-agents">
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>{rejected.length} 个主机 Agent 的凭据被拒绝</AlertTitle>
      <AlertDescription>
        <p>
          这些主机仍在连接，但本库不认可其凭据（例如恢复的备份早于该主机接入，或主机已重新接入而旧 Agent 仍在运行）。
          已知服务器：重新签发接入令牌并重新接入其 Agent。本库没有的服务器：先停用该主机的 Agent，
          手动清理其上的实例与卷，再作为新服务器接入（见运维手册 Restoring production 第 6 步）。
        </p>
        <ul className="mt-2 space-y-1">
          {rejected.map((entry) => {
            const server = servers?.find((item) => item.id === entry.serverId);
            return (
              <li key={entry.serverId} className="[overflow-wrap:anywhere]">
                {server ? (
                  <Link
                    to="/servers/$id"
                    params={{ id: server.id }}
                    search={{ tab: 'connect' }}
                    className="font-medium underline underline-offset-4"
                  >
                    {server.name}
                  </Link>
                ) : (
                  <span className="font-mono text-xs">{entry.serverId}</span>
                )}
                {' · '}
                {entry.reason === 'unknown_server' ? '本库没有此服务器' : '凭据与本库不符'}
                {' · '}
                来自 {entry.clientAddress ?? '未知地址'}
                {' · '}
                {entry.attempts} 次，最近 {relativeTime(entry.lastSeenAt)}
              </li>
            );
          })}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
