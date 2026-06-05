import { Injectable } from '@nestjs/common';
import { ActionAvailability, ContainerAction, ContainerPhase, ContainerStatus, RuntimeDriftKind, type RuntimeDriftDto } from '@nyabase/common';

export interface ContainerActionPolicyInput {
  phase: ContainerPhase;
  runtimeStatus: ContainerStatus | null;
  runtimeReady: boolean;
  runtimeDrift: RuntimeDriftDto[];
  activeOperationId: string | null;
  runtimeConfirmationPending?: boolean;
  runtimeConfirmationExpired?: boolean;
}

@Injectable()
export class ContainerActionPolicyService {
  disabled(reason: ActionAvailability['reason'], message: string, operationId?: string | null): ActionAvailability {
    return { enabled: false, reason, message, operationId: operationId ?? undefined };
  }

  enabled(): ActionAvailability {
    return { enabled: true };
  }

  allDisabled(reason: ActionAvailability['reason'], message: string): Record<ContainerAction, ActionAvailability> {
    return {
      start: this.disabled(reason, message),
      stop: this.disabled(reason, message),
      restart: this.disabled(reason, message),
      delete: this.disabled(reason, message),
      stats: this.disabled(reason, message),
      console: this.disabled(reason, message),
      updateMounts: this.disabled(reason, message),
      enableSsh: this.disabled(reason, message),
      reconcileSsh: this.disabled(reason, message),
    };
  }

  forContainer(input: ContainerActionPolicyInput): Record<ContainerAction, ActionAvailability> {
    if (input.activeOperationId) {
      return this.allDisabled('operation_in_progress', `Operation ${input.activeOperationId} is still running`);
    }
    if (!input.runtimeReady) {
      return this.allDisabled('agent_state_unready', 'Agent runtime state is not ready; wait for the first full state report');
    }
    if (input.runtimeConfirmationPending) {
      const running = input.runtimeStatus === ContainerStatus.Running;
      return {
        start: this.disabled('runtime_confirmation_pending', '上一个操作已完成，正在等待 agent 上报运行态确认'),
        stop: this.disabled('runtime_confirmation_pending', '上一个操作已完成，正在等待 agent 上报运行态确认'),
        restart: this.disabled('runtime_confirmation_pending', '上一个操作已完成，正在等待 agent 上报运行态确认'),
        delete: this.disabled('runtime_confirmation_pending', '上一个操作已完成，正在等待 agent 上报运行态确认'),
        stats: running ? this.enabled() : this.disabled('phase_not_active', 'Container is not running'),
        console: running ? this.enabled() : this.disabled('phase_not_active', 'Container is not running'),
        updateMounts: this.disabled('runtime_confirmation_pending', '上一个操作已完成，正在等待 agent 上报运行态确认'),
        enableSsh: this.disabled('runtime_confirmation_pending', '上一个操作已完成，正在等待 agent 上报运行态确认'),
        reconcileSsh: this.disabled('runtime_confirmation_pending', '上一个操作已完成，正在等待 agent 上报运行态确认'),
      };
    }
    if (input.phase === ContainerPhase.Deleted || input.phase === ContainerPhase.Deleting) {
      return this.allDisabled('phase_not_active', 'Container is being deleted or already deleted');
    }
    if (input.phase === ContainerPhase.Provisioning || input.phase === ContainerPhase.Updating) {
      return this.allDisabled('phase_not_active', 'Container is not active yet');
    }
    if (input.phase === ContainerPhase.Failed) {
      return {
        ...this.allDisabled('phase_not_active', 'Container is failed'),
        delete: this.enabled(),
      };
    }
    const hasRuntimeDrift = !input.runtimeConfirmationExpired && input.runtimeDrift.some((drift) =>
      drift.kind === RuntimeDriftKind.RuntimeMissing
      || drift.kind === RuntimeDriftKind.RuntimeUnbound
      || drift.kind === RuntimeDriftKind.RuntimeIdMismatch
      || drift.kind === RuntimeDriftKind.SpecGenerationStale
      || drift.kind === RuntimeDriftKind.PowerIntentMismatch,
    );
    if (hasRuntimeDrift) {
      return {
        ...this.allDisabled('runtime_missing', 'Runtime state does not match desired state'),
        delete: this.enabled(),
        reconcileSsh: this.enabled(),
      };
    }
    const running = input.runtimeStatus === ContainerStatus.Running;
    const stopped = input.runtimeStatus === ContainerStatus.Exited || input.runtimeStatus === ContainerStatus.Dead;
    return {
      start: stopped ? this.enabled() : this.disabled('phase_not_active', 'Container is not stopped'),
      stop: running ? this.enabled() : this.disabled('phase_not_active', 'Container is not running'),
      restart: running ? this.enabled() : this.disabled('phase_not_active', 'Container is not running'),
      delete: this.enabled(),
      stats: running ? this.enabled() : this.disabled('phase_not_active', 'Container is not running'),
      console: running ? this.enabled() : this.disabled('phase_not_active', 'Container is not running'),
      updateMounts: this.enabled(),
      enableSsh: this.enabled(),
      reconcileSsh: running ? this.enabled() : this.disabled('phase_not_active', 'Container is not running'),
    };
  }
}
