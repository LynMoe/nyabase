import { Copy, TriangleAlert } from 'lucide-react';
import type { ServerEnrollmentDto } from '@nyabase/common';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Button } from '../ui/button.js';
import { toast } from '../../hooks/use-toast.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';

export const AGENT_ENV_FILE = '/etc/nyabase/agent.env';
export const AGENT_STATE_DIR = '/var/lib/nyabase-agent';

/**
 * Shell snippet that writes the agent env file and starts the host agent. The
 * agent lets guest NICs attach only to the bridges listed here: the server's
 * LAN bridge.
 */
export function agentInstallSnippet(backendUrl: string, enrollmentToken: string, parentInterface: string): string {
  return [
    'sudo install -d -m 0700 /etc/nyabase',
    `sudo tee ${AGENT_ENV_FILE} >/dev/null <<'EOF'`,
    `NYABASE_BACKEND_URL=${backendUrl}`,
    `NYABASE_AGENT_ENROLLMENT_TOKEN=${enrollmentToken}`,
    `NYABASE_AGENT_GUEST_BRIDGES=${parentInterface}`,
    'EOF',
    `sudo chmod 0600 ${AGENT_ENV_FILE}`,
    'sudo systemctl enable --now nyabase-agent',
  ].join('\n');
}

function backendOrigin(): string {
  return globalThis.location?.origin ?? 'https://nyabase.example.com';
}

async function copyWithToast(value: string, what: string) {
  const ok = await copyOneTimeSecret(value);
  toast({
    title: ok ? `${what}已复制` : '复制失败',
    description: ok ? undefined : '请手动选中内容复制',
    variant: ok ? 'default' : 'destructive',
  });
}

/**
 * The one-time agent enrollment token and how to install it on the host.
 * Only the token's digest is stored, so this is the single chance to copy it.
 */
export function EnrollmentInstructions(
  { enrollment, parentInterface }: { enrollment: ServerEnrollmentDto; parentInterface: string },
) {
  const snippet = agentInstallSnippet(backendOrigin(), enrollment.enrollmentToken, parentInterface);
  return (
    <div className="space-y-3" data-testid="server-enrollment">
      <Alert variant="warning">
        <TriangleAlert className="h-4 w-4" />
        <AlertDescription>
          接入令牌只显示这一次，关闭后无法再次查看；令牌在 {new Date(enrollment.expiresAt).toLocaleString('zh-CN')} 前有效，
          使用一次即失效。丢失或过期后可在服务器详情「接入」页重新签发。
        </AlertDescription>
      </Alert>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">接入令牌（仅此一次）</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { void copyWithToast(enrollment.enrollmentToken, '接入令牌'); }}
          >
            <Copy className="h-3.5 w-3.5" />复制令牌
          </Button>
        </div>
        <p className="break-all rounded-md border bg-muted/30 p-2 font-mono text-sm" data-testid="server-enrollment-token">
          {enrollment.enrollmentToken}
        </p>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            在服务器上以 root 执行（写入 <span className="font-mono">{AGENT_ENV_FILE}</span> 并启动 nyabase-agent）
          </p>
          <Button size="sm" variant="outline" onClick={() => { void copyWithToast(snippet, '安装命令'); }}>
            <Copy className="h-3.5 w-3.5" />复制命令
          </Button>
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 font-mono text-xs">
          {snippet}
        </pre>
        <p className="text-xs text-muted-foreground">
          Agent 只在本地没有凭据时使用令牌；若这台主机曾经接入过，请先停止 nyabase-agent 并清空
          <span className="mx-1 font-mono">{AGENT_STATE_DIR}</span>再启动。
        </p>
      </div>
    </div>
  );
}
