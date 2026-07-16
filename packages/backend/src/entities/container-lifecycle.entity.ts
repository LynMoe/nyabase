import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import { ContainerPhase } from '@nyabase/common';
import { ContainerEntity } from './container.entity.js';

@Entity('container_lifecycle')
export class ContainerLifecycleEntity {
  @PrimaryColumn({ name: 'container_id', type: 'text' })
  @ForeignKey(() => ContainerEntity, { onDelete: 'CASCADE' })
  containerId: string;

  @Index()
  @Column({ type: 'text', default: ContainerPhase.Provisioning })
  phase: ContainerPhase;

  @Index()
  @Column({ name: 'bound_runtime_id', type: 'text', nullable: true })
  boundRuntimeId: string | null;

  /** Immutable create evidence used to finish cleanup after runtime loss. */
  @Column({ name: 'quota_paths_json', type: 'simple-json', default: '[]' })
  quotaPathsJson: string[];

  @Column({ name: 'runtime_spec_hash', type: 'text', nullable: true })
  runtimeSpecHash: string | null;

  @Index()
  @Column({ name: 'active_task_id', type: 'text', nullable: true })
  activeTaskId: string | null;

  @Column({ name: 'last_transition_at', type: 'datetime' })
  lastTransitionAt: Date;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ name: 'failure_code', type: 'text', nullable: true })
  failureCode: string | null;
}
