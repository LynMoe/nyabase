export interface ServerStatus {
  serverId: string;
  serverName: string;
  hostname: string;
  online: boolean;
  present: boolean;
  pulling?: { progress: number; message: string };
  error?: string;
}
