import {
  Entity, PrimaryColumn, Column, Index, CreateDateColumn, UpdateDateColumn, Unique,
} from 'typeorm';

@Entity('remote_fs_server_assignments')
@Unique(['remoteFsMountId', 'serverId'])
export class RemoteFsServerAssignmentEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  remoteFsMountId: string;

  @Index()
  @Column('text')
  serverId: string;

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
