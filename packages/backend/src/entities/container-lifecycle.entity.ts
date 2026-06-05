import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { ContainerPhase, ContainerPowerIntent, OperationKind } from '@nyabase/common';

export interface RuntimeConfirmationLock {
  operationId: string;
  kind: OperationKind;
  startedAt: string;
  deadlineAt: string;
  expectedRuntimeId?: string;
  expectedGeneration?: number;
  expectedPowerIntent?: ContainerPowerIntent;
}

@Entity('container_lifecycle')
export class ContainerLifecycleEntity {
  @PrimaryColumn({ name: 'container_id', type: 'text' })
  containerId: string;

  @Index()
  @Column({ type: 'text', default: ContainerPhase.Provisioning })
  phase: ContainerPhase;

  @Index()
  @Column({ name: 'bound_runtime_id', type: 'text', nullable: true })
  boundRuntimeId: string | null;

  @Index()
  @Column({ name: 'active_operation_id', type: 'text', nullable: true })
  activeOperationId: string | null;

  @Column({ name: 'runtime_confirmation', type: 'simple-json', nullable: true })
  runtimeConfirmation: RuntimeConfirmationLock | null;

  @Column({ name: 'last_transition_at', type: 'datetime' })
  lastTransitionAt: Date;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ name: 'failure_code', type: 'text', nullable: true })
  failureCode: string | null;
}
