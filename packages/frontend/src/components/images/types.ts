import type { AgentTaskDto } from '@nyabase/common';

export interface ServerStatus {
  serverId: string;
  serverName: string;
  hostname: string;
  online: boolean;
  present: boolean;
  task?: AgentTaskDto;
}
