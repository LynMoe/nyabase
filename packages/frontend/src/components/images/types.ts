import type { UserAgentTaskDto } from '@nyabase/common';

export type ImageTaskStatusDto = UserAgentTaskDto;

export interface ServerStatus {
  serverId: string;
  serverName: string;
  hostname: string;
  online: boolean;
  present: boolean;
  task?: ImageTaskStatusDto | null;
}
