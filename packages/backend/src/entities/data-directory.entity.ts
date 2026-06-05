import {
  Entity, PrimaryColumn, Column, Index, Unique, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('data_directories')
@Unique(['sourceKind', 'sourceId', 'name'])
export class DataDirectoryEntity {
  @PrimaryColumn('text')
  id: string;

  /** Owner user id — stored in DB only, does not appear in the filesystem path */
  @Index()
  @Column('text')
  userId: string;

  @Column('text')
  sourceKind: 'local' | 'remote';

  /** For local: data_disks.id; for remote: remote_fs_mounts.id */
  @Index()
  @Column('text')
  sourceId: string;

  /** Directory name — unique per source */
  @Column('text')
  name: string;

  /**
   * Populated only for local sources (data_disks.serverId).
   * Remote sources are shared across servers, so this is NULL.
   */
  @Index()
  @Column({ type: 'text', nullable: true })
  serverId: string | null;

  /** uid used for chown when the directory was created */
  @Column({ type: 'integer', default: 1000 })
  uid: number;

  @Index()
  @Column({ type: 'text', default: 'active' })
  desiredState: 'active' | 'removing';

  @Column({ type: 'integer', default: 1 })
  generation: number;

  @Column({ type: 'text', nullable: true })
  lastOperationId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
