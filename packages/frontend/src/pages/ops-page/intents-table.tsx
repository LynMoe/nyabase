import { type IntentDto } from '@nyabase/common';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { IntentResourceName, IntentServerRef } from '../../components/intents/intent-detail-dialog.js';
import { ResourceRef } from '../../components/refs/resource-ref.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { intentPending } from '../../lib/in-progress.js';
import {
  failureCodeLabel,
  intentKindLabel,
  intentResourceTypeLabel,
  intentStatusLabel,
} from '../../lib/status-labels.js';
import { formatIntentAttempt, statusBadgeVariant } from '../../lib/intent-visibility.js';

export function IntentsTable({
  items,
  linkServers,
  onSelect,
}: {
  items: IntentDto[];
  linkServers: boolean;
  onSelect: (intent: IntentDto) => void;
}) {
  return (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>资源类型</TableHead>
                <TableHead>资源名称</TableHead>
                <TableHead>服务器</TableHead>
                <TableHead>请求人</TableHead>
                <TableHead>尝试</TableHead>
                <TableHead>失败码</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((intent) => (
                <TableRow
                  key={intent.id}
                  className="cursor-pointer"
                  onClick={() => onSelect(intent)}
                >
                  <TableCell>{new Date(intent.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{intentKindLabel(intent.kind)}</TableCell>
                  <TableCell>
                    <StatusBadge
                      label={intentStatusLabel(intent.status)}
                      raw={intent.status}
                      pending={intentPending(intent.status)}
                      variant={statusBadgeVariant(intent.status)}
                    />
                  </TableCell>
                  <TableCell>{intentResourceTypeLabel(intent.resourceType)}</TableCell>
                  <TableCell title={intent.resourceId}>
                    <IntentResourceName intent={intent} />
                  </TableCell>
                  <TableCell>
                    <IntentServerRef serverId={intent.serverId} link={linkServers} />
                  </TableCell>
                  <TableCell>
                    {intent.requestedBy
                      ? <ResourceRef kind="user" id={intent.requestedBy} />
                      : '系统'}
                  </TableCell>
                  <TableCell>{formatIntentAttempt(intent)}</TableCell>
                  <TableCell>{failureCodeLabel(intent.failureCode) ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
  );
}
