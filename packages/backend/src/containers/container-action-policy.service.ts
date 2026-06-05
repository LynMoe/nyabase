import { Injectable } from '@nestjs/common';
import { ActionAvailability, ContainerAction, ContainerPhase, ContainerStatus } from '@nyabase/common';

export interface ContainerActionPolicyInput {
  phase: ContainerPhase;
  runtimeStatus: ContainerStatus | null;
  runtimeStale: boolean;
  activeOperationId: string | null;
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
    if (input.runtimeStale) {
      return {
        ...this.allDisabled('runtime_stale', 'Runtime observation is stale'),
        delete: this.enabled(),
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
