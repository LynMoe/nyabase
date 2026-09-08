import type {
  ExtensionSupportCheckDto,
  ExtensionSupportDto,
} from '@nyabase/common';
import { Badge } from '../ui/badge.js';

function summary(supported: boolean | null): { label: string; variant: 'success' | 'destructive' | 'secondary' } {
  if (supported === true) return { label: '可启用', variant: 'success' };
  if (supported === false) return { label: '条件不足', variant: 'destructive' };
  return { label: '无法检测', variant: 'secondary' };
}

function checkStatus(status: ExtensionSupportCheckDto['status']): string {
  if (status === 'pass') return '通过';
  if (status === 'fail') return '未通过';
  return '未知';
}

export function ServerExtensionSupport({ support }: { support: ExtensionSupportDto }) {
  const badge = summary(support.supported);
  return (
    <div className="space-y-1.5" data-testid="server-extension-support">
      <div className="flex items-center gap-2">
        <p className="text-xs text-muted-foreground">本机检测</p>
        <Badge variant={badge.variant} data-testid="server-extension-support-status">
          {badge.label}
        </Badge>
      </div>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {support.checks.map((check) => (
          <li key={check.id} data-check-id={check.id} data-check-status={check.status}>
            {check.label} · {checkStatus(check.status)}
            {check.detail ? ` · ${check.detail}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
