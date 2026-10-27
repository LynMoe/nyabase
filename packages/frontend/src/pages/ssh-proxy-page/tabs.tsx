import { BarChart3, History, RadioTower, Route, ShieldX } from 'lucide-react';
import { TabsList, TabsTrigger } from '../../components/ui/tabs.js';

export const SSH_PROXY_TABS = ['live', 'lines', 'history', 'stats', 'refusals'] as const;
export type SshProxyTab = (typeof SSH_PROXY_TABS)[number];

/** Tabs about the proxy itself (status, host keys, lines, refusals); the rest is everyone's connection history. */
const OPERATIONS_TABS: readonly SshProxyTab[] = ['live', 'lines', 'refusals'];

export function parseSshProxyTab(value: unknown): SshProxyTab {
  return SSH_PROXY_TABS.includes(value as SshProxyTab) ? (value as SshProxyTab) : 'live';
}

/** The tab to show: without the operations role, its tabs fall back to the history. */
export function visibleSshProxyTab(tab: SshProxyTab, canOperate: boolean): SshProxyTab {
  return canOperate || !OPERATIONS_TABS.includes(tab) ? tab : 'history';
}

const TAB_ITEMS = [
  ['live', '实时', RadioTower],
  ['lines', '线路', Route],
  ['history', '连接历史', History],
  ['stats', '统计', BarChart3],
  ['refusals', '未认证连接', ShieldX],
] as const;

export function SshProxyTabsList({ canOperate }: { canOperate: boolean }) {
  return (
    <TabsList className="h-auto w-full flex-nowrap justify-start overflow-x-auto">
      {TAB_ITEMS.filter(([key]) => canOperate || !OPERATIONS_TABS.includes(key)).map(([key, label, Icon]) => (
        <TabsTrigger key={key} value={key} className="gap-1.5">
          <Icon className="h-4 w-4" />{label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
