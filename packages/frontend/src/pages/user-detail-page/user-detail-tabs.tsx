import { Gauge, ShieldCheck } from 'lucide-react';
import type { UserDto } from '@nyabase/common';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { CanonicalGrantPanel } from '../../components/grants/canonical-grant-panel.js';
import type { UserDetailTab } from '../../lib/user-detail.js';
import { UserOverviewTab } from './user-overview-tab.js';

const TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['grants', '授权', ShieldCheck],
] as const;

export function UserDetailTabs({
  tab,
  user,
  canManageUsers,
  canManageGrants,
  onTab,
  onEditIdentity,
}: {
  tab: UserDetailTab;
  user: UserDto;
  canManageUsers: boolean;
  canManageGrants: boolean;
  onTab: (tab: UserDetailTab) => void;
  onEditIdentity: () => void;
}) {
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
        <UserOverviewTab
          user={user}
          canManageUsers={canManageUsers}
          onEditIdentity={onEditIdentity}
        />
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
