import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { RefreshCw } from 'lucide-react';

interface AuditLog {
  id: string;
  actorId: string | null;
  action: string;
  targetId: string | null;
  targetType: string | null;
  payload: unknown;
  ts: string;
}

// Action badges keep semantic colour buckets — these are state pills, not generic grays.
// Tinted backgrounds use the /10 token so they read correctly in both themes;
// foreground colors gain a `dark:` variant to stay legible on dark cards.
const ACTION_COLORS: Record<string, string> = {
  'container.create': 'bg-green-500/10 text-green-700 dark:text-green-300',
  'container.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'container.start': 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  'container.stop': 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
  'container.restart': 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300',
  'user.create': 'bg-purple-500/10 text-purple-700 dark:text-purple-300',
  'user.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'server.create': 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  'quota.update': 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
};

export default function AuditPage() {
  const { data: logs = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<AuditLog[]>('/audit?limit=200'),
    refetchInterval: 30_000,
  });

  return (
    <div className="p-6 space-y-5 w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">审计日志</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{logs.length} 条记录</p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-12 bg-muted rounded-lg animate-pulse" />)}
        </div>
      ) : logs.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-10 text-center text-muted-foreground/70">
          暂无审计记录
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground w-44">时间</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground w-28">操作者</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground w-40">操作</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">目标</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-accent/50">
                  <td className="py-2.5 px-4 text-muted-foreground/70 text-xs whitespace-nowrap">
                    {new Date(log.ts).toLocaleString('zh-CN', {
                      month: '2-digit', day: '2-digit',
                      hour: '2-digit', minute: '2-digit', second: '2-digit',
                    })}
                  </td>
                  <td className="py-2.5 px-4 text-xs font-mono text-muted-foreground">
                    {log.actorId?.slice(0, 8) ?? 'system'}
                  </td>
                  <td className="py-2.5 px-4">
                    <span className={`inline-block text-xs px-2 py-0.5 rounded font-medium
                      ${ACTION_COLORS[log.action] ?? 'bg-muted text-muted-foreground'}`}>
                      {log.action}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 text-xs text-muted-foreground/70 font-mono">
                    {log.targetId ? `${log.targetType}:${log.targetId.slice(0, 16)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
