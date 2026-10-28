import { useQuery } from '@tanstack/react-query';
import type { GrantServerProfileDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { serverProfileRows } from '../../lib/grant-server-profile.js';
import { queryKeys } from '../../lib/query-keys.js';

/** What the bundle's server has, beside the quota fields, for reference while filling them in. */
export function ServerProfilePanel({ serverId }: { serverId: string }) {
  const query = useQuery({
    queryKey: queryKeys.grantBundles.serverProfile(serverId),
    queryFn: () => api.get<GrantServerProfileDto>(`/admin/grant-bundles/server-profiles/${serverId}`),
    enabled: Boolean(serverId),
    staleTime: 60_000,
  });
  if (!serverId) return null;
  return (
    <section className="rounded-md border bg-muted/30 p-3 text-sm" aria-label="服务器配置">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-medium">服务器配置</h3>
        {query.data && !query.data.live ? (
          <span className="text-xs text-muted-foreground">服务器暂不可达，只显示已记录的信息</span>
        ) : null}
      </div>
      {query.isLoading ? <p className="text-muted-foreground">读取中…</p> : null}
      {query.isError ? <p className="text-destructive">{errorMessage(query.error)}</p> : null}
      {query.data ? (
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5">
          {serverProfileRows(query.data).map((row, index) => (
            <div key={`${row.label}-${index}`} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0">
                <span className="tabular-nums">{row.value}</span>
                {row.detail ? <span className="block truncate text-xs text-muted-foreground" title={row.detail}>{row.detail}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
