import { CheckCircle, XCircle, Circle, Loader2, Download, RefreshCw } from 'lucide-react';
import type { ServerStatus } from './types.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Progress } from '../ui/progress.js';

interface ServerStatusRowProps {
  status: ServerStatus;
  onPull: () => void;
  pulling: boolean;
}

// Renders the per-server pull progress row used inside an image card.
// Despite the file name, this is rendered inline (not a Radix Dialog) since
// pull progress is shown alongside server status in the expanded card.
export function ServerStatusRow({ status: s, onPull, pulling }: ServerStatusRowProps) {
  const isPullingThis = !!s.pulling;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-5 flex justify-center shrink-0">
        {!s.online ? (
          <Circle className="h-4 w-4 text-muted-foreground/40" />
        ) : isPullingThis ? (
          <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
        ) : s.error ? (
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

        {isPullingThis && s.pulling && (
          <div className="mt-1.5 space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span className="truncate max-w-[300px]">{s.pulling.message}</span>
              <span className="shrink-0 ml-2">{s.pulling.progress}%</span>
            </div>
            <Progress value={s.pulling.progress} className="h-1.5" />
          </div>
        )}

        {s.error && (
          <p className="text-xs text-destructive mt-0.5 truncate">{s.error}</p>
        )}
      </div>

      <div className="shrink-0 w-20 text-right">
        {isPullingThis ? (
          <span className="text-xs text-blue-500 font-medium">Pull 中</span>
        ) : s.present ? (
          <span className="text-xs text-green-600 font-medium">已就绪</span>
        ) : s.error ? (
          <span className="text-xs text-destructive font-medium">失败</span>
        ) : s.online ? (
          <span className="text-xs text-muted-foreground">未拉取</span>
        ) : (
          <span className="text-xs text-muted-foreground/50">离线</span>
        )}
      </div>

      {s.online && !s.present && !isPullingThis && (
        <Button
          variant="outline" size="sm" className="shrink-0"
          disabled={pulling}
          onClick={onPull}
        >
          <Download className="h-4 w-4" />Pull
        </Button>
      )}

      {s.online && s.present && (
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
