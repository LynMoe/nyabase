import { Link } from '@tanstack/react-router';
import { FileQuestion } from 'lucide-react';
import { Button } from './ui/button.js';
import { useDocumentTitle } from '../hooks/use-document-title.js';

/** The root route's not-found screen (an unknown URL). */
export function NotFound() {
  useDocumentTitle('页面不存在');
  return (
    <div className="flex min-h-full items-center justify-center p-6" data-testid="not-found">
      <div className="w-full max-w-md space-y-4 p-6 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FileQuestion className="h-5 w-5" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">页面不存在</h1>
        <div className="flex justify-center gap-2">
          <Button variant="outline" onClick={() => window.history.back()}>返回上一页</Button>
          <Button asChild><Link to="/">返回首页</Link></Button>
        </div>
      </div>
    </div>
  );
}
