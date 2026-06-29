import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { ContainerStatus } from '@nyabase/common';

@Entity('container_ssh_routes')
export class ContainerSshRouteEntity {
  @PrimaryColumn({ name: 'container_id', type: 'text' })
  containerId: string;

  @Index()
  @Column({ name: 'server_id', type: 'text' })
  serverId: string;

  @Column({ name: 'runtime_id', type: 'text' })
  runtimeId: string;

  @Column({ name: 'macvlan_ip', type: 'text', nullable: true })
  macvlanIp: string | null;

  @Column({ name: 'runtime_status', type: 'text' })
  runtimeStatus: ContainerStatus;

  @Column({ name: 'ssh_status', type: 'text' })
  sshStatus: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';

  @Column({ name: 'applied_internal_key_generation', type: 'int', nullable: true })
  appliedInternalKeyGeneration: number | null;

  @Column({ name: 'container_host_key_fingerprint', type: 'text', nullable: true })
  containerHostKeyFingerprint: string | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Index()
  @Column({ name: 'observed_at', type: 'datetime' })
  observedAt: Date;
}
