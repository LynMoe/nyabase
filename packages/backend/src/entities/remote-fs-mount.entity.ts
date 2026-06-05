import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';
import type { RemoteFsParams } from '@nyabase/common';

@Entity('remote_fs_mounts')
export class RemoteFsMountEntity {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  name: string;

  @Column({ type: 'text', nullable: true })
  displayName: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Discriminator: 'nfs' | 'cephfs' */
  @Column('text')
  type: string;

  @Column('text')
  hostMountPoint: string;

  @Column({ type: 'text', default: '' })
  options: string;

  /** Type-specific parameters stored as JSON */
  @Column({ type: 'simple-json' })
  params: RemoteFsParams;

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
