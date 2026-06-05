import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('resource_locks')
export class ResourceLockEntity {
  @PrimaryColumn('text')
  resourceKey: string;

  @Index()
  @Column('text')
  holderId: string;

  @Column({ type: 'int', default: 0 })
  fencingToken: number;

  @Index()
  @Column('datetime')
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
