import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  ForeignKey,
} from 'typeorm';
import { AgentTaskKind, AgentTaskStatus } from '@nyabase/common';
import { ServerEntity } from './server.entity.js';

@Entity('agent_tasks')
@Index(['serverId', 'status', 'lastSentAt'])
@Index(['resourceType', 'resourceId', 'status'])
export class AgentTaskEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column({ type: 'text' })
  kind: AgentTaskKind;

  @Index()
  @ForeignKey(() => ServerEntity, { onDelete: 'CASCADE' })
  @Column({ name: 'server_id', type: 'text' })
  serverId: string;

  @Index()
  @Column({ name: 'resource_type', type: 'text' })
  resourceType: string;

  @Index()
  @Column({ name: 'resource_id', type: 'text' })
  resourceId: string;

  @Index()
  @Column({ name: 'requested_by', type: 'text', nullable: true })
  requestedBy: string | null;

  @Column({ name: 'request_json', type: 'simple-json', nullable: true })
  requestJson: unknown | null;

  @Column({ name: 'payload_json', type: 'simple-json' })
  payloadJson: unknown;

  @Column({ name: 'payload_hash', type: 'text' })
  payloadHash: string;

  @Index('IDX_agent_tasks_admission_class')
  @Column({ name: 'admission_class', type: 'text', default: 'normal' })
  admissionClass: 'normal' | 'reconciliation' | 'safety';

  @Index()
  @Column({ type: 'text', default: AgentTaskStatus.Pending })
  status: AgentTaskStatus;

  @Column({ name: 'failure_stage', type: 'text', nullable: true })
  failureStage: 'dispatch' | 'agent' | 'finalizer' | null;

  @Column({ name: 'agent_result_json', type: 'simple-json', nullable: true })
  agentResultJson: unknown | null;

  @Column({ name: 'dispatch_attempt_count', type: 'integer', default: 0 })
  dispatchAttemptCount: number;

  @Column({ name: 'incomplete_result_count', type: 'integer', default: 0 })
  incompleteResultCount: number;

  /** Start of the current explicit retry epoch; unlike startedAt this may reset. */
  @Index('IDX_agent_tasks_retry_window_started_at')
  @Column({ name: 'retry_window_started_at', type: 'datetime', nullable: true })
  retryWindowStartedAt: Date | null;

  @Index('IDX_agent_tasks_next_dispatch_at')
  @Column({ name: 'next_dispatch_at', type: 'datetime', nullable: true })
  nextDispatchAt: Date | null;

  @Column({ name: 'finalizer_attempt_count', type: 'integer', default: 0 })
  finalizerAttemptCount: number;

  @Index('IDX_agent_tasks_finalizer_retry_at')
  @Column({ name: 'finalizer_retry_at', type: 'datetime', nullable: true })
  finalizerRetryAt: Date | null;

  @Column({ name: 'result_json', type: 'simple-json', nullable: true })
  resultJson: unknown | null;

  @Column({ name: 'error_json', type: 'simple-json', nullable: true })
  errorJson: unknown | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'started_at', type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Index()
  @Column({ name: 'last_sent_at', type: 'datetime', nullable: true })
  lastSentAt: Date | null;

  @Index()
  @Column({ name: 'completed_at', type: 'datetime', nullable: true })
  completedAt: Date | null;
}
