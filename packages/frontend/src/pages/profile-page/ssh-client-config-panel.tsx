import { useQuery } from '@tanstack/react-query';
import { Copy, TerminalSquare } from 'lucide-react';
import type { SshClientConfigDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { Button } from '../../components/ui/button.js';

/**
 * The one-time client setup: an ssh_config block that reaches every container
 * as `<name>.<suffix>`, and known_hosts lines for the proxy and for this
 * user's host CA, so no connection ever asks to confirm a fingerprint.
 */
export function SshClientConfigPanel({ userId }: { userId: string }) {
  const query = useQuery({
    queryKey: queryKeys.sshClientConfig(userId),
    queryFn: () => api.get<SshClientConfigDto>(`/users/${userId}/ssh-client-config`),
    staleTime: 60_000,
  });
  const config = query.data;
  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-4" data-testid="ssh-client-config">
      <div className="flex min-w-0 items-center gap-2">
        <TerminalSquare className="h-4 w-4 shrink-0 text-primary" />
        <h2 className="text-base font-semibold text-foreground">SSH 客户端配置</h2>
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">正在加载...</p>
      ) : query.isError || !config ? (
        <p className="text-sm text-destructive">SSH 客户端配置加载失败</p>
      ) : !config.sshConfig || !config.knownHosts ? (
        <p className="text-sm text-muted-foreground">管理员尚未配置 SSH 代理的公网地址，暂时无法生成配置。</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            把下面两段分别加入本机文件，只需一次。之后你的每个容器都可以用
            {' '}<code className="font-mono">ssh root@&lt;容器名&gt;.{config.hostSuffix}</code>{' '}
            登录（登录用户以容器页面为准），不会再出现主机指纹确认。
          </p>
          <ConfigBlock title="~/.ssh/config" value={config.sshConfig} testId="ssh-client-config-ssh" />
          <ConfigBlock title="~/.ssh/known_hosts" value={config.knownHosts} testId="ssh-client-config-known-hosts" />
          <p className="text-xs text-muted-foreground">
            第二行信任的是只属于你的主机证书 CA，它只为你自己的容器签发证书。管理员修改主机名后缀、轮换代理主机密钥或重置证书 CA 后需要重新复制。
          </p>
        </>
      )}
    </section>
  );
}

function ConfigBlock({ title, value, testId }: { title: string; value: string; testId: string }) {
  const copy = async () => {
    const ok = await copyOneTimeSecret(value);
    toast({ title: ok ? `${title} 内容已复制` : '复制失败', variant: ok ? 'default' : 'destructive' });
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">{title}</span>
        <Button size="sm" variant="ghost" onClick={() => { void copy(); }}>
          <Copy className="h-4 w-4" />复制
        </Button>
      </div>
      <pre
        className="overflow-x-auto whitespace-pre rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs"
        data-testid={testId}
      >
        {value}
      </pre>
    </div>
  );
}
