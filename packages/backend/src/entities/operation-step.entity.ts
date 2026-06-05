import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { HookKind, HookStatus } from '@nyabase/common';

@Entity('operation_steps')
@Unique(['operationId', 'stepKey'])
export class OperationStepEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  operationId: string;

  @Column('text')
  stepKey: string;

  @Column({ type: 'int', default: 0 })
  sequence: number;

  @Index()
  @Column({ type: 'text', nullable: true })
  hook: HookKind | null;

  @Index()
  @Column({ type: 'text', default: HookStatus.Pending })
  status: HookStatus;

  @Column({ type: 'int', nullable: true })
  desiredGeneration: number | null;

  @Column({ type: 'text', nullable: true })
  commandId: string | null;

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

  @Column({ type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  completedAt: Date | null;
}
