import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { OperationKind, OperationStatus } from '@nyabase/common';

@Entity('operations')
@Unique(['idempotencyKey'])
export class OperationEntity {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  idempotencyKey: string;

  @Index()
  @Column('text')
  kind: OperationKind;

  @Index()
  @Column('text')
  resourceType: string;

  @Index()
  @Column('text')
  resourceId: string;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column({ type: 'text', nullable: true })
  requestedBy: string | null;

  @Index()
  @Column({ type: 'text', default: OperationStatus.Queued })
  status: OperationStatus;

  @Column({ type: 'simple-json', nullable: true })
  request: unknown | null;

  @Column({ type: 'simple-json', nullable: true })
  result: unknown | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Index()
  @Column({ type: 'datetime', nullable: true })
  completedAt: Date | null;
}
