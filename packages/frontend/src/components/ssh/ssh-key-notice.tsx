import { Link } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.js';
import { Button } from '../ui/button.js';
import { cn } from '../../lib/utils.js';

/**
 * Shown while the signed-in user has no SSH public key: the jump host only
 * accepts key logins, so without one every copied command ends in
 * "Permission denied (publickey)". Keys added later reach existing
 * containers automatically.
 */
export function SshKeyNotice({
  variant = 'banner',
  className,
  onNavigate,
}: {
  /** banner: page-level callout. inline: one line inside a card or dialog. */
  variant?: 'banner' | 'inline';
  className?: string;
  /** Called before leaving, e.g. to close the dialog the notice sits in. */
  onNavigate?: () => void;
}) {
  const link = (
    <Link to="/profile" onClick={onNavigate} className="font-medium underline underline-offset-4">
      去添加 →
    </Link>
  );
  if (variant === 'inline') {
    return (
      <p
        className={cn('flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm', className)}
        data-testid="ssh-key-missing"
      >
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <span>尚未添加 SSH 公钥，无法通过 SSH 登录。{link}</span>
      </p>
    );
  }
  return (
    <Alert variant="warning" className={className} data-testid="ssh-key-missing">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div className="space-y-1">
            <AlertTitle className="mb-0 leading-5">尚未添加 SSH 公钥</AlertTitle>
            <AlertDescription className="text-muted-foreground">容器只能用公钥登录，添加后即可通过 SSH 连接。</AlertDescription>
          </div>
        </div>
        <Button size="sm" variant="outline" asChild>
          <Link to="/profile" onClick={onNavigate}>添加公钥</Link>
        </Button>
      </div>
    </Alert>
  );
}
