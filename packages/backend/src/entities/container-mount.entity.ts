import {
  Entity, PrimaryColumn, Column, Index, Unique, CreateDateColumn, UpdateDateColumn, ForeignKey,
} from 'typeorm';
import { ContainerEntity } from './container.entity.js';
import { ServerEntity } from './server.entity.js';

/** Desired container mount specifications keyed by stable container ID. */
@Entity('container_mounts')
@Unique(['serverId', 'containerId', 'containerPath'])
@Unique(['serverId', 'containerId', 'sourceKind', 'sourceId', 'userId', 'dirName'])
export class ContainerMountEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @ForeignKey(() => ServerEntity, { onDelete: 'RESTRICT' })
  @Column('text')
  serverId: string;

  @Index()
  @ForeignKey(() => ContainerEntity, { onDelete: 'CASCADE' })
  @Column('text')
  containerId: string;

  @Index()
  @Column('text')
  containerName: string;

  @Column('text')
  sourceKind: 'local' | 'remote';

  @Column('text')
  sourceId: string;

  /** Immutable physical identity captured with the container mount intent. */
  @Column('text')
  sourceIdentity: string;

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
