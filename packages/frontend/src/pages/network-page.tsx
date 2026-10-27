import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Tabs, TabsContent } from '../components/ui/tabs.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { IpPoolsTab } from './network-page/ip-pools-tab.js';
import { FirewallTab } from '../components/firewall/firewall-tab.js';
import { NetworkTabsList, parseNetworkTab } from './network-page/tabs.js';

const routeApi = getRouteApi('/network/');

/** 网络: the IP pools guests get addresses from, and the egress firewall their traffic passes. */
export default function NetworkPage() {
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/network/' });
  return (
    <Page testId="network">
      <PageHeader title="网络" />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          void navigate({ search: { tab: parseNetworkTab(value) }, replace: true });
        }}
      >
        <NetworkTabsList />
        <TabsContent value="ip-pools" className="space-y-4">
          {tab === 'ip-pools' ? <IpPoolsTab /> : null}
        </TabsContent>
        <TabsContent value="firewall" className="space-y-4">
          {tab === 'firewall' ? <FirewallTab /> : null}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
