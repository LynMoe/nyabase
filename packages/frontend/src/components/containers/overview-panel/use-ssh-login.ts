import { formatSshProxyJumpLogin, type ContainerDto } from '@nyabase/common';
import { usePublicSettings } from '../../../hooks/use-public-settings.js';
import { toast } from '../../../hooks/use-toast.js';
import { copyOneTimeSecret } from '../../../lib/one-time-secret.js';
import { useAuthStore } from '../../../store/auth.js';

/**
 * The ways to reach a container over the SSH jump host: the one-line command
 * and an `~/.ssh/config` snippet. Both are null until the proxy address and the
 * container's IP are known.
 */
export function useSshLogin(container: ContainerDto) {
  const { settings } = usePublicSettings();
  const authUser = useAuthStore((state) => state.user);
  const username = container.ownerName ?? authUser?.username ?? '<username>';
  const jumpLogin = formatSshProxyJumpLogin({
    username,
    containerName: container.name,
  });
  const proxyHostValue = container.ssh.proxyHost?.trim()
    || settings.sshProxy?.host
    || null;
  const proxyPortValue = container.ssh.proxyPort
    ?? settings.sshProxy?.port
    ?? null;
  const proxyHost = proxyHostValue
    ? (proxyPortValue && proxyPortValue !== 22
      ? `${proxyHostValue}:${proxyPortValue}`
      : proxyHostValue)
    : null;
  const routedIp = container.routedIp;
  const loginUser = container.ssh.loginUser || 'root';
  const jumpCommand = proxyHost && routedIp
    ? `ssh -J ${jumpLogin}@${proxyHost} ${loginUser}@${routedIp}`
    : null;
  const configSnippet = proxyHost && routedIp
    ? [
      `Host ${container.name}`,
      `  HostName ${routedIp}`,
      `  User ${loginUser}`,
      `  ProxyJump ${jumpLogin}@${proxyHost}`,
    ].join('\n')
    : null;
  const copyText = async (value: string, title: string) => {
    const ok = await copyOneTimeSecret(value);
    toast({
      title: ok ? title : '复制失败',
      description: ok ? undefined : '请手动选中后复制',
      variant: ok ? 'default' : 'destructive',
    });
  };
  return { proxyHost, jumpCommand, configSnippet, copyText };
}

export type SshLogin = ReturnType<typeof useSshLogin>;
