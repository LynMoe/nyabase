import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export type ContainerMountRuntimeStatus = 'mounted' | 'missing' | 'extra' | 'error' | 'unknown';

@Entity('container_mount_runtime')
@Unique(['serverId', 'dockerId', 'containerPath'])
export class ContainerMountRuntimeEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column({ type: 'text', nullable: true })
  containerId: string | null;

  @Index()
  @Column({ type: 'text', nullable: true })
  dockerId: string | null;

  @Column({ type: 'text', nullable: true })
  desiredMountId: string | null;

  @Column('text')
  containerPath: string;

  @Column({ type: 'text', nullable: true })
  sourceKind: 'local' | 'remote' | null;

  @Column({ type: 'text', nullable: true })
  sourceId: string | null;

  @Column({ type: 'text', nullable: true })
  dirName: string | null;

  @Column({ type: 'text', nullable: true })
  expectedHostPath: string | null;

  @Column({ type: 'text', nullable: true })
  observedHostPath: string | null;

  @Index()
  @Column({ type: 'text', default: 'unknown' })
  status: ContainerMountRuntimeStatus;

  @Column({ type: 'int', nullable: true })
  desiredGeneration: number | null;

  @Column({ type: 'int', nullable: true })
  reportSeq: number | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Index()
  @Column({ type: 'datetime', nullable: true })
  observedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
