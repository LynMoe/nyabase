import {
  Entity, PrimaryColumn, Column, Index, CreateDateColumn, UpdateDateColumn, Unique, ForeignKey,
} from 'typeorm';
import { RemoteFsMountEntity } from './remote-fs-mount.entity.js';
import { ServerEntity } from './server.entity.js';

@Entity('remote_fs_server_assignments')
@Unique(['remoteFsMountId', 'serverId'])
export class RemoteFsServerAssignmentEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @ForeignKey(() => RemoteFsMountEntity, { onDelete: 'RESTRICT' })
  @Column('text')
  remoteFsMountId: string;

  @Index()
  @ForeignKey(() => ServerEntity, { onDelete: 'RESTRICT' })
  @Column('text')
  serverId: string;

  @Index()
  @Column({ type: 'text', default: 'ensuring' })
  desiredState: 'ensuring' | 'active' | 'removing' | 'failed';

  @Column({ type: 'integer', default: 1 })
  generation: number;

  @Column({ type: 'text', nullable: true })
  lastTaskId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
