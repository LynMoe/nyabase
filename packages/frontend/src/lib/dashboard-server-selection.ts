export interface DashboardServerCandidate {
  id: string;
  status: string;
}

export function preferredDashboardServerId(servers: DashboardServerCandidate[]): string {
  const onlineServers = servers.filter((server) => server.status === 'online');
  return onlineServers[0]?.id
    ?? servers[0]?.id
    ?? '';
}
