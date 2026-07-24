export interface DashboardServerCandidate {
  id: string;
  status: string;
  hasGpu?: boolean;
}

export function dashboardServerHasGpu(server: DashboardServerCandidate): boolean {
  return server.hasGpu === true;
}

export function preferredDashboardServerId(servers: DashboardServerCandidate[]): string {
  const onlineServers = servers.filter((server) => server.status === 'online');
  return onlineServers.find(dashboardServerHasGpu)?.id
    ?? onlineServers[0]?.id
    ?? servers[0]?.id
    ?? '';
}
