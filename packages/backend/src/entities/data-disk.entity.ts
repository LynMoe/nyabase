import {
  Entity, PrimaryColumn, Column, Index, Unique, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('data_disks')
@Unique(['serverId', 'mountPoint'])
export class DataDiskEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  serverId: string;

  @Column('text')
  mountPoint: string;

  @Column({ type: 'text', nullable: true })
  label: string | null;

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
