import { Copy } from 'lucide-react';
import { Button } from '../../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/dialog.js';
import type { SshLogin } from './use-ssh-login.js';

export function SshConfigDialog({
  open,
  onOpenChange,
  containerName,
  login,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  containerName: string;
  login: SshLogin;
}) {
  const { configSnippet, copyText } = login;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>~/.ssh/config 片段</DialogTitle>
          <DialogDescription>加入本机 SSH 配置后，可以直接 <code className="font-mono">ssh {containerName}</code>。</DialogDescription>
        </DialogHeader>
        {configSnippet ? (
          <div className="space-y-3">
            <pre className="overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs" data-testid="ssh-jump-config">{configSnippet}</pre>
            <Button variant="outline" onClick={() => { void copyText(configSnippet, 'SSH 配置已复制'); }}>
              <Copy className="h-4 w-4" />复制
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
