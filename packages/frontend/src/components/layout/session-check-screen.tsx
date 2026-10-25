import { Button } from '../ui/button.js';
import { terminateBrowserSession } from '../../lib/auth-session.js';
import { useDocumentTitle } from '../../hooks/use-document-title.js';

/**
 * Full-page screen for a cold load whose session check did not finish (error
 * or a throttled refresh). Retrying loads the app once the check succeeds;
 * signing out is always offered (POST /auth/logout needs only the cookie), as
 * /login is hidden while the browser still holds a session.
 */
export function SessionCheckScreen({ title, message, retrying, onRetry }: {
  title: string;
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  useDocumentTitle(title);
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        <div className="flex justify-center gap-2">
          <Button variant="outline" onClick={() => { void terminateBrowserSession(); }}>退出登录</Button>
          <Button disabled={retrying} onClick={onRetry}>
            {retrying ? '重试中...' : '重试'}
          </Button>
        </div>
      </div>
    </div>
  );
}
