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
  @PrimaryColumn({ name: 'resource_key', type: 'text' })
  resourceKey: string;

  @Index()
  @Column({ name: 'operation_id', type: 'text' })
  operationId: string;

  @Index()
  @Column({ name: 'server_id', type: 'text' })
  serverId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
