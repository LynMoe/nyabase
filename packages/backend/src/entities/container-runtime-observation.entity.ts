import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import {
  ContainerStatus,
  type ContainerSshServerState,
  type ContainerStatsSummary,
} from '@nyabase/common';

@Entity('container_runtime_observations')
@Unique(['serverId', 'dockerId', 'reportSeq'])
export class ContainerRuntimeObservationEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column({ type: 'text', nullable: true })
  containerId: string | null;

  @Index()
  @Column('text')
  dockerId: string;

  @Index()
  @Column({ type: 'int', default: 0 })
  reportSeq: number;

  @Index()
  @Column({ type: 'text', default: ContainerStatus.Unknown })
  status: ContainerStatus;

  @Column({ type: 'simple-json', nullable: true })
  stats: ContainerStatsSummary | null;

  @Column({ type: 'simple-json', nullable: true })
  sshServer: ContainerSshServerState | null;

  @Column({ type: 'simple-json', nullable: true })
  labels: Record<string, string> | null;

  @Column({ type: 'boolean', default: false })
  labelsValid: boolean;

  @Column({ type: 'int', nullable: true })
  specGenerationSeen: number | null;

  @Column('datetime')
  firstSeenAt: Date;

  @Index()
  @Column('datetime')
  lastSeenAt: Date;

  @Column({ type: 'datetime', nullable: true })
  missingSince: Date | null;

  @Index()
  @Column({ type: 'boolean', default: false })
  stale: boolean;
}
