import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm';
import { ContainerStatus } from '@nyabase/common';

@Entity('runtime_containers')
@Unique(['serverId', 'runtimeId'])
export class RuntimeContainerEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column({ name: 'server_id', type: 'text' })
  serverId: string;

  @Index()
  @Column({ name: 'runtime_id', type: 'text' })
  runtimeId: string;

  @Index()
  @Column({ name: 'container_id', type: 'text', nullable: true })
  containerId: string | null;

  @Index()
  @Column({ name: 'owner_id', type: 'text', nullable: true })
  ownerId: string | null;

  @Column({ name: 'owner_numeric_id', type: 'int', nullable: true })
  ownerNumericId: number | null;

  @Index()
  @Column({ type: 'text', default: ContainerStatus.Unknown })
  status: ContainerStatus;

  @Column({ name: 'spec_generation_seen', type: 'int', nullable: true })
  specGenerationSeen: number | null;

  @Column({ type: 'text', nullable: true })
  ip: string | null;

  @Column({ name: 'labels_json', type: 'simple-json', default: '{}' })
  labelsJson: Record<string, string>;

  @Column({ name: 'first_seen_at', type: 'datetime' })
  firstSeenAt: Date;

  @Index()
  @Column({ name: 'last_seen_at', type: 'datetime' })
  lastSeenAt: Date;

  @Index()
  @Column({ type: 'boolean', default: false })
  stale: boolean;
}
