import {
  Entity, PrimaryColumn, Column, Index, CreateDateColumn, UpdateDateColumn, ForeignKey,
} from 'typeorm';
import { ServerEntity } from './server.entity.js';

@Entity('data_directories')
@Index('IDX_data_directory_local_physical', ['serverId', 'sourceId', 'name'], {
  unique: true,
  where: `"sourceKind" = 'local'`,
})
@Index('IDX_data_directory_remote_physical', ['sourceId', 'name'], {
  unique: true,
  where: `"sourceKind" = 'remote'`,
})
export class DataDirectoryEntity {
  @PrimaryColumn('text')
  id: string;

  /** Owner user id — stored in DB only, does not appear in the filesystem path */
  @Index()
  @Column('text')
  userId: string;

  @Column('text')
  sourceKind: 'local' | 'remote';

  /** For local: agent.yaml localDataSources.id; for remote: remote_fs_mounts.id */
  @Index()
  @Column('text')
  sourceId: string;

  /** Directory name — unique per source */
  @Column('text')
  name: string;

  /** Immutable physical filesystem identity captured with the reservation. */
  @Column('text')
  sourceIdentity: string;

  /**
   * Populated only for local sources.
   * Remote sources are shared across servers, so this is NULL.
   */
  @Index()
  @ForeignKey(() => ServerEntity, { onDelete: 'RESTRICT' })
  @Column({ type: 'text', nullable: true })
  serverId: string | null;

  /** uid used for chown when the directory was created */
  @Column({ type: 'integer', default: 1000 })
  uid: number;

  @Index()
  @Column({ type: 'text', default: 'active' })
  desiredState: 'creating' | 'active' | 'removing' | 'failed';

  @Column({ type: 'integer', default: 1 })
  generation: number;

  @Column({ type: 'text', nullable: true })
  lastTaskId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
