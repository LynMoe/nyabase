import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DockerDaemonState } from '@nyabase/common';

@Entity('docker_daemon_runtime_observations')
export class DockerDaemonRuntimeObservationEntity {
  @PrimaryColumn({ name: 'server_id', type: 'text' })
  serverId: string;

  @Column({ type: 'text', default: DockerDaemonState.Unknown })
  state: DockerDaemonState;

  @Column({ name: 'unit_file_in_sync', type: 'boolean', default: false })
  unitFileInSync: boolean;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  @Column({ type: 'boolean', default: false })
  active: boolean;

  @Column({ type: 'int', nullable: true })
  pid: number | null;

  @Column({ name: 'docker_root', type: 'text' })
  dockerRoot: string;

  @Column({ name: 'socket_path', type: 'text' })
  socketPath: string;

  @Column({ name: 'server_version', type: 'text', nullable: true })
  serverVersion: string | null;

  @Column({ name: 'storage_driver', type: 'text', nullable: true })
  storageDriver: string | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Index()
  @Column({ name: 'checked_at', type: 'datetime' })
  checkedAt: Date;

  @Index()
  @Column({ name: 'observed_at', type: 'datetime' })
  observedAt: Date;
}
