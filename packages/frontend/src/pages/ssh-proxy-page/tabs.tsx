import { BarChart3, History, RadioTower, ShieldX } from 'lucide-react';
import { TabsList, TabsTrigger } from '../../components/ui/tabs.js';

export const SSH_PROXY_TABS = ['live', 'history', 'stats', 'refusals'] as const;
export type SshProxyTab = (typeof SSH_PROXY_TABS)[number];

export function parseSshProxyTab(value: unknown): SshProxyTab {
  return SSH_PROXY_TABS.includes(value as SshProxyTab) ? (value as SshProxyTab) : 'live';
}

const TAB_ITEMS = [
  ['live', '实时', RadioTower],
  ['history', '连接历史', History],
  ['stats', '统计', BarChart3],
  ['refusals', '未认证连接', ShieldX],
] as const;

export function SshProxyTabsList() {
  return (
    <TabsList className="h-auto w-full flex-nowrap justify-start overflow-x-auto">
      {TAB_ITEMS.map(([key, label, Icon]) => (
        <TabsTrigger key={key} value={key} className="gap-1.5">
          <Icon className="h-4 w-4" />{label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
