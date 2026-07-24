import { AlertTriangle, Loader2, SearchX, ShieldOff } from 'lucide-react';
import { ApiError } from '../lib/api.js';
import { Button } from './ui/button.js';

export interface QueryErrorPresentation {
  title: string;
  description: string;
  kind: 'forbidden' | 'not-found' | 'network' | 'error';
}

export function queryErrorPresentation(error: unknown, resourceName = '内容'): QueryErrorPresentation {
  if (error instanceof ApiError && error.status === 403) {
    return { title: '无权访问', description: `当前账号没有查看此${resourceName}的权限。`, kind: 'forbidden' };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { title: `${resourceName}不存在`, description: `它可能已被删除，或链接已经失效。`, kind: 'not-found' };
  }
  if (error instanceof ApiError && error.status === 0) {
    return { title: '网络连接失败', description: error.message, kind: 'network' };
  }
  return {
    title: `无法加载${resourceName}`,
    description: error instanceof Error ? error.message : '请稍后重试。',
    kind: 'error',
  };
}

export function QueryLoadingState({ label = '加载中...' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />{label}
    </div>
  );
}

export function QueryErrorState({
  error,
  resourceName,
  onRetry,
  onBack,
}: {
  error: unknown;
  resourceName?: string;
  onRetry?: () => void;
  onBack?: () => void;
}) {
  const presentation = queryErrorPresentation(error, resourceName);
  const Icon = presentation.kind === 'forbidden'
    ? ShieldOff
    : presentation.kind === 'not-found'
      ? SearchX
      : AlertTriangle;
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Icon className="h-8 w-8 text-muted-foreground/50 mb-2" />
      <p className="text-sm font-medium text-foreground">{presentation.title}</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-md">{presentation.description}</p>
      {(onRetry || onBack) && (
        <div className="flex gap-2 mt-4">
          {onBack && <Button size="sm" variant="outline" onClick={onBack}>返回</Button>}
          {onRetry && presentation.kind !== 'forbidden' && (
            <Button size="sm" variant="outline" onClick={onRetry}>重试</Button>
          )}
        </div>
      )}
    </div>
  );
}
