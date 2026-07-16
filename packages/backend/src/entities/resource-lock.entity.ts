import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  ForeignKey,
} from 'typeorm';
import { ServerEntity } from './server.entity.js';
import { AgentTaskEntity } from './agent-task.entity.js';

@Entity('resource_locks')
export class ResourceLockEntity {
  @PrimaryColumn({ name: 'resource_key', type: 'text' })
  resourceKey: string;

  @Index()
  @ForeignKey(() => AgentTaskEntity, { onDelete: 'RESTRICT' })
  @Column({ name: 'task_id', type: 'text' })
  taskId: string;

  @Index()
  @ForeignKey(() => ServerEntity, { onDelete: 'RESTRICT' })
  @Column({ name: 'server_id', type: 'text' })
  serverId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
