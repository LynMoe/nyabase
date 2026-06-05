import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { HookKind, HookStatus } from '@nyabase/common';

@Entity('reconcile_tasks')
export class ReconcileTaskEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column({ type: 'text', nullable: true })
  operationId: string | null;

  @Index()
  @Column('text')
  hook: HookKind;

  @Index()
  @Column('text')
  resourceType: string;

  @Index()
  @Column('text')
  resourceId: string;

  @Index()
  @Column('text')
  serverId: string;

  @Column({ type: 'int', nullable: true })
  desiredGeneration: number | null;

  @Index()
  @Column({ type: 'text', default: HookStatus.Pending })
  status: HookStatus;

  @Column({ type: 'int', default: 0 })
  priority: number;

  @Index()
  @Column('datetime')
  nextAttemptAt: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'simple-json', nullable: true })
  result: unknown | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
