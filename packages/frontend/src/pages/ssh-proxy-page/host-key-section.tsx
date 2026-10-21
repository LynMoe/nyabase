import { RefreshCw, RotateCcw } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { SshProxyHostKeySummaryDto } from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { QueryView } from '../../components/layout/query-view.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { InfoCell, formatTime } from './status-sections.js';

export function HostKeySection({
  query,
  fetching,
  rotating,
  onRefresh,
  onRotate,
}: {
  query: UseQueryResult<SshProxyHostKeySummaryDto>;
  fetching: boolean;
  rotating: boolean;
  onRefresh: () => void;
  onRotate: () => void;
}) {
  return (
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-foreground">SSH 主机密钥</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => onRefresh()} disabled={fetching}>
              <RefreshCw className={`h-4 w-4 ${fetching ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={rotating}
              onClick={() => onRotate()}
            >
              <RotateCcw className="h-4 w-4" />
              轮换
            </Button>
          </div>
        </div>
        <QueryView query={query} resourceName="SSH 主机密钥" loadingLabel="加载 SSH 主机密钥...">
          {(hostKey) => (
            <div className="rounded-lg border border-border bg-card p-4 grid gap-3 sm:grid-cols-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">指纹</p>
                {hostKey.fingerprint ? (
                  <div className="mt-1">
                    <TechnicalId label="指纹" value={hostKey.fingerprint} kind="opaque" />
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-foreground">未配置</p>
                )}
              </div>
              <InfoCell label="版本" value={hostKey.generation?.toString() ?? '未配置'} />
              <InfoCell label="轮换时间" value={hostKey.rotatedAt ? formatTime(hostKey.rotatedAt) : '从未轮换'} />
            </div>
          )}
        </QueryView>
      </section>
  );
}
