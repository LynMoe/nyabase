import { CheckCircle, XCircle, Circle, Loader2, Download, RefreshCw } from 'lucide-react';
import { AgentTaskStatus } from '@nyabase/common';
import type { ServerStatus } from './types.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';

interface ServerStatusRowProps {
  status: ServerStatus;
  onPull: () => void;
  pulling: boolean;
  mode?: 'pull' | 'delete';
}

// Renders the per-server pull progress row used inside an image card.
// Despite the file name, this is rendered inline (not a Radix Dialog) since
// pull progress is shown alongside server status in the expanded card.
export function ServerStatusRow({ status: s, onPull, pulling, mode = 'pull' }: ServerStatusRowProps) {
  const isPullingThis = s.task?.status === AgentTaskStatus.Pending;
  const failed = s.task?.status === AgentTaskStatus.Failed;
  const succeeded = s.task?.status === AgentTaskStatus.Succeeded;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-5 flex justify-center shrink-0">
        {!s.online ? (
          <Circle className="h-4 w-4 text-muted-foreground/40" />
        ) : isPullingThis ? (
          <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
        ) : failed ? (
          <XCircle className="h-4 w-4 text-destructive" />
        ) : s.present ? (
          <CheckCircle className="h-4 w-4 text-green-500" />
        ) : (
          <Circle className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{s.serverName || s.hostname}</span>
          <Badge variant={s.online ? 'secondary' : 'outline'} className="text-xs shrink-0">
            {s.online ? '在线' : '离线'}
          </Badge>
        </div>

        {failed && (
          <p className="text-xs text-destructive mt-0.5 truncate">
            {taskErrorMessage(s.task?.error, mode)}
          </p>
        )}
      </div>

      <div className="shrink-0 w-20 text-right">
        {mode === 'delete' ? (
          isPullingThis ? (
            <span className="text-xs text-blue-500 font-medium">清理中</span>
          ) : failed ? (
            <span className="text-xs text-destructive font-medium">清理失败</span>
          ) : succeeded ? (
            <span className="text-xs text-green-600 font-medium">清理完成</span>
          ) : (
            <span className="text-xs text-muted-foreground">等待清理</span>
          )
        ) : isPullingThis ? (
          <span className="text-xs text-blue-500 font-medium">Pull 中</span>
        ) : s.present ? (
          <span className="text-xs text-green-600 font-medium">已就绪</span>
        ) : failed ? (
          <span className="text-xs text-destructive font-medium">失败</span>
        ) : s.online ? (
          <span className="text-xs text-muted-foreground">未拉取</span>
        ) : (
          <span className="text-xs text-muted-foreground/50">离线</span>
        )}
      </div>

      {mode === 'pull' && s.online && !s.present && !isPullingThis && (
        <Button
          variant="outline" size="sm" className="shrink-0"
          disabled={pulling}
          onClick={onPull}
        >
          <Download className="h-4 w-4" />Pull
        </Button>
      )}

      {mode === 'pull' && s.online && s.present && (
        <Button
          variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground"
          disabled={pulling}
          onClick={onPull}
          title="重新拉取（更新镜像）"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

function taskErrorMessage(error: unknown, mode: 'pull' | 'delete'): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return mode === 'delete' ? '镜像清理失败' : 'Pull 失败';
}
