import { Network, ShieldBan } from 'lucide-react';
import { TabsList, TabsTrigger } from '../../components/ui/tabs.js';

export const NETWORK_TABS = ['ip-pools', 'firewall'] as const;
export type NetworkTab = (typeof NETWORK_TABS)[number];

export function parseNetworkTab(value: unknown): NetworkTab {
  return NETWORK_TABS.includes(value as NetworkTab) ? (value as NetworkTab) : 'ip-pools';
}

const TAB_ITEMS = [
  ['ip-pools', 'IP 池', Network],
  ['firewall', '防火墙', ShieldBan],
] as const;

export function NetworkTabsList() {
  return (
    <TabsList>
      {TAB_ITEMS.map(([key, label, Icon]) => (
        <TabsTrigger key={key} value={key} className="gap-1.5" data-testid={`network-tab-${key}`}>
          <Icon className="h-4 w-4" />{label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
