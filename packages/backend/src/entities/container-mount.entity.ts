import {
  Entity, PrimaryColumn, Column, Index, Unique, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

/** Legacy table name; rows now store containerId-keyed desired mount specs. */
@Entity('container_mounts')
@Unique(['serverId', 'containerId', 'containerPath'])
@Unique(['serverId', 'containerId', 'sourceKind', 'sourceId', 'userId', 'dirName'])
export class ContainerMountEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column('text')
  containerId: string;

  /** Observed Docker binding kept for migration/backfill/result compatibility only. */
  @Index()
  @Column({ type: 'text', nullable: true })
  dockerId: string | null;

  @Index()
  @Column('text')
  containerName: string;

  @Column('text')
  sourceKind: 'local' | 'remote';

  @Column('text')
  sourceId: string;

  @Column('text')
  userId: string;

  @Column('text')
  dirName: string;

  @Column('text')
  containerPath: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
