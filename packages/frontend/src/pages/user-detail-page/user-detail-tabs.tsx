import { useState } from 'react';
import { Gauge, Pencil, ShieldCheck } from 'lucide-react';
import { Capability, type UserDto, UserStatus } from '@nyabase/common';
import { Link } from '@tanstack/react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { CanonicalGrantPanel } from '../../components/grants/canonical-grant-panel.js';
import type { UserDetailTab } from '../../lib/detail-tabs.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Field } from '../../components/layout/form-field.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { capabilityLabel, userStatusLabel } from '../../lib/display-labels.js';
import { userDeleting } from '../../lib/in-progress.js';
import { relativeTime } from '../../lib/utils.js';
import { useAuthStore } from '../../store/auth.js';
import { UserIdentityDialog } from './user-dialogs.js';

const TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['grants', '授权', ShieldCheck],
] as const;

export function UserDetailTabs({
  tab,
  user,
  onTab,
}: {
  tab: UserDetailTab;
  user: UserDto;
  onTab: (tab: UserDetailTab) => void;
}) {
  const canManageGrants = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageGrants) ?? false,
  );
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTab(value as UserDetailTab)}
      data-testid="user-detail-tabs"
    >
      <TabsList>
        {TAB_ITEMS.map(([key, label, Icon]) => (
          <TabsTrigger key={key} value={key} className="gap-1.5" data-testid={`user-tab-${key}`}>
            <Icon className="h-4 w-4" />{label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="overview" className="mt-4 space-y-6">
        <UserOverviewTab user={user} />
      </TabsContent>
      <TabsContent value="grants" className="mt-4 space-y-6">
        {canManageGrants ? (
          <CanonicalGrantPanel subject={user} kind="users" />
        ) : (
          <p className="text-sm text-muted-foreground">查看与编辑授权需要「管理授权」权限。</p>
        )}
      </TabsContent>
    </Tabs>
  );
}

/** Identity, group membership and effective capabilities of a user. */
function UserOverviewTab({ user }: { user: UserDto }) {
  const canManageUsers = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageUsers) ?? false,
  );
  const [identityOpen, setIdentityOpen] = useState(false);
  return (
    <>
      <SectionCard
        title="身份"
        actions={canManageUsers ? (
          <Button size="sm" variant="outline" onClick={() => setIdentityOpen(true)}>
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
      {identityOpen ? <UserIdentityDialog user={user} onClose={() => setIdentityOpen(false)} /> : null}
    </>
  );
}
