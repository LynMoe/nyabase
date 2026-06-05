import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { AgentCommandStatus } from '@nyabase/common';

@Entity('agent_command_outbox')
@Unique(['idempotencyKey'])
export class AgentCommandOutboxEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  operationId: string;

  @Index()
  @Column({ type: 'text', nullable: true })
  operationStepId: string | null;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column('text')
  resourceKey: string;

  @Column('text')
  commandKind: string;

  @Column('text')
  idempotencyKey: string;

  @Column({ type: 'int', nullable: true })
  desiredGeneration: number | null;

  @Column({ type: 'simple-json', nullable: true })
  payload: unknown | null;

  @Index()
  @Column({ type: 'text', default: AgentCommandStatus.Pending })
  status: AgentCommandStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Index()
  @Column({ type: 'datetime', nullable: true })
  nextAttemptAt: Date | null;

  @Column({ type: 'text', nullable: true })
  leaseHolderId: string | null;

  @Column({ type: 'datetime', nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  sentAt: Date | null;

  @Index()
  @Column({ type: 'datetime', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
