import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource, readSourceDir } from './read-source.test-helper.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readSource(root, rel);
const firewall = () => readSourceDir(root, 'components/firewall');

describe('网络 page', () => {
  it('keeps IP pools and the firewall as two tabs in the route search', () => {
    const route = read('routes/network/index.tsx');
    expect(route).toMatch(/createFileRoute\('\/network\/'\)/);
    expect(route).toMatch(/validateSearch/);
    expect(route).toMatch(/parseNetworkTab/);
    const page = read('pages/network-page.tsx');
    expect(page).toMatch(/title="网络"/);
    expect(page).toMatch(/IP 池/);
    expect(page).toMatch(/防火墙/);
    expect(page).toMatch(/navigate\(\{ search: \{ tab: parseNetworkTab\(value\) \}, replace: true \}\)/);
  });

  it('lists firewall rules with their sync state and explains how they match', () => {
    expect(read('pages/network-page.tsx')).toMatch(/<FirewallTab \/>/);
    const page = firewall();
    for (const heading of ['优先级', '名称', '动作', '协议 / 端口', '目标网段', '关联服务器']) {
      expect(page).toContain(`<TableHead>${heading}</TableHead>`);
    }
    expect(page).toContain("'/admin/firewall-rules'");
    expect(page).toContain("'/admin/firewall-rules/status'");
    expect(page).toMatch(/hasPendingFirewallSync/);
    expect(page).toMatch(/queryKeys\.firewall\.all/);
  });

  it('warns in the editor that stateless rules drop replies too', () => {
    const page = firewall();
    expect(page).toMatch(/回包同样会被拦截/);
    expect(page).toMatch(/firewallRulePatch/);
    expect(page).toMatch(/FIREWALL_MAX_CIDRS_PER_RULE/);
    expect(page).toMatch(/disabled=\{portsDisabled\}/);
  });

  it('is what the sidebar and the server checklist link to', () => {
    expect(read('lib/navigation.ts')).toMatch(/to: '\/network', icon: Network, label: '网络'/);
    expect(read('pages/server-detail-page/server-tabs.tsx')).toMatch(/to="\/network" search=\{\{ tab: 'ip-pools' \}\}/);
    expect(read('routeTree.gen.ts')).not.toMatch(/ip-pools/);
  });

  it('shows the agent firewall next to the IPv6 guard', () => {
    const card = read('components/servers/agent-card.tsx');
    expect(card).toMatch(/agent\.firewall/);
    expect(card).toMatch(/agentFirewallBadge/);
    expect(card).toMatch(/server-agent-ipv6-guard/);
  });
});
