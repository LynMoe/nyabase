import { Link } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import type { UserDto } from '@nyabase/common';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { userStatusLabel } from '../../lib/display-labels.js';
import { userDeleting } from '../../lib/in-progress.js';

export function UsersTable({
  users: visibleUsers,
  canManage,
  currentUserId,
  onDelete,
}: {
  users: UserDto[];
  canManage: boolean;
  currentUserId: string | undefined;
  onDelete: (user: UserDto) => void;
}) {
  return (
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHead>用户</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>用户组</TableHead>
            {canManage ? <TableHead className="text-right">操作</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleUsers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={canManage ? 4 : 3} className="py-8 text-center text-muted-foreground">
                没有符合条件的用户
              </TableCell>
            </TableRow>
          ) : null}
          {visibleUsers.map((user) => (
            <TableRow key={user.id}>
              <TableCell className="whitespace-normal">
                <Link
                  to="/users/$id"
                  params={{ id: user.id }}
                  search={{ tab: 'overview' }}
                  className="block min-w-0"
                >
                  <p className="font-medium">{user.displayName}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">@{user.username}</p>
                </Link>
              </TableCell>
              <TableCell>
                <StatusBadge
                  label={userStatusLabel(user.status)}
                  pending={userDeleting(user.status)}
                  variant={user.status === 'active' ? 'success' : 'secondary'}
                />
              </TableCell>
              <TableCell className="whitespace-normal">
                <div className="flex flex-wrap gap-1">
                  {user.groups.length === 0
                    ? <span className="text-muted-foreground">无</span>
                    : user.groups.map((group) => (
                      <Link
                        key={group.id}
                        to="/groups/$id"
                        params={{ id: group.id }}
                        search={{ tab: 'overview' }}
                      >
                        <Badge variant="outline">{group.name}</Badge>
                      </Link>
                    ))}
                </div>
              </TableCell>
              {canManage ? (
                <TableCell className="text-right">
                  {user.id !== currentUserId ? (
                    <Button size="sm" variant="ghost-destructive" onClick={() => onDelete(user)}>
                      <Trash2 className="h-4 w-4" />删除
                    </Button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
  );
}
