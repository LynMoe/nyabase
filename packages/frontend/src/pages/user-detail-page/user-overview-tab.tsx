import { Link } from '@tanstack/react-router';
import { Pencil } from 'lucide-react';
import { UserStatus, type UserDto } from '@nyabase/common';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Field } from '../../components/layout/field.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { capabilityLabel, userStatusLabel } from '../../lib/display-labels.js';
import { userDeleting } from '../../lib/in-progress.js';
import { relativeTime } from '../../lib/utils.js';

/** Identity, group membership and effective capabilities of a user. */
export function UserOverviewTab({
  user,
  canManageUsers,
  onEditIdentity,
}: {
  user: UserDto;
  canManageUsers: boolean;
  onEditIdentity: () => void;
}) {
  return (
    <>
      <SectionCard
        title="身份"
        actions={canManageUsers ? (
          <Button size="sm" variant="outline" onClick={onEditIdentity}>
            <Pencil className="h-3.5 w-3.5" />编辑
          </Button>
        ) : undefined}
      >
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label="显示名称" value={user.displayName} />
          <Field label="用户名" value={`@${user.username}`} mono />
          <div>
            <p className="text-xs text-muted-foreground">状态</p>
            <div className="mt-1">
              <StatusBadge
                label={userStatusLabel(user.status)}
                pending={userDeleting(user.status)}
                variant={user.status === UserStatus.Active ? 'success' : 'secondary'}
              />
            </div>
          </div>
          <Field label="创建时间" value={relativeTime(user.createdAt)} />
        </div>
      </SectionCard>
      <SectionCard
        title="用户组"
        flush={user.groups.length > 0}
      >
        {user.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">未加入任何用户组。</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>类型</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {user.groups.map((group) => (
                <TableRow key={group.id}>
                  <TableCell>
                    <Link
                      to="/groups/$id"
                      params={{ id: group.id }}
                      search={{ tab: 'overview' }}
                      className="font-medium"
                    >
                      {group.name}
                    </Link>
                  </TableCell>
                  <TableCell>{group.isSystem ? '系统组' : '自定义组'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
      <SectionCard title="能力">
        {user.capabilities.length === 0 ? (
          <p className="text-sm text-muted-foreground">无。</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {user.capabilities.map((capability) => (
              <Badge key={capability} variant="outline">{capabilityLabel(capability)}</Badge>
            ))}
          </div>
        )}
      </SectionCard>
    </>
  );
}
