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
@Unique(['commandId'])
export class OperationEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  kind: OperationKind;

  @Index()
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

  @Column({ name: 'command_id', type: 'text' })
  commandId: string;

  @Column({ name: 'command_kind', type: 'text' })
  commandKind: string;

  @Column({ name: 'resource_keys_json', type: 'simple-json' })
  resourceKeysJson: string[];

  @Column({ name: 'unlock_report_kind', type: 'text', nullable: true })
  unlockReportKind: 'state' | 'data_dir' | null;

  @Index()
  @Column({ type: 'text', default: OperationStatus.Queued })
  status: OperationStatus;

  @Column({ name: 'request_json', type: 'simple-json', nullable: true })
  requestJson: unknown | null;

  @Column({ name: 'payload_json', type: 'simple-json', nullable: true })
  payloadJson: unknown | null;

  @Column({ name: 'hook_plan_json', type: 'simple-json' })
  hookPlanJson: unknown[];

  @Column({ name: 'hook_results_json', type: 'simple-json' })
  hookResultsJson: unknown[];

  @Column({ name: 'result_json', type: 'simple-json', nullable: true })
  resultJson: unknown | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'started_at', type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'command_completed_at', type: 'datetime', nullable: true })
  commandCompletedAt: Date | null;

  @Index()
  @Column({ name: 'completed_at', type: 'datetime', nullable: true })
  completedAt: Date | null;
}
