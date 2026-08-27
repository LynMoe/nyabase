import { Injectable } from '@nestjs/common';
import {
  ContainerPhase,
  ContainerStatus,
  type ActionAvailability,
  type ContainerAction,
} from '@nyabase/common';

export interface ContainerActionPolicyInput {
  phase: ContainerPhase;
  runtimeStatus: ContainerStatus | null;
  runtimeReady: boolean;
  intentPending: boolean;
  sshEnabled: boolean;
}

@Injectable()
export class ContainerActionPolicyService {
  disabled(
    reason: ActionAvailability['reason'],
    message: string,
  ): ActionAvailability {
    return { enabled: false, reason, message };
  }

  enabled(): ActionAvailability {
    return { enabled: true };
  }

  allDisabled(
    reason: ActionAvailability['reason'],
    message: string,
  ): Record<ContainerAction, ActionAvailability> {
    return {
      start: this.disabled(reason, message),
      stop: this.disabled(reason, message),
      restart: this.disabled(reason, message),
      delete: this.disabled(reason, message),
      stats: this.disabled(reason, message),
      console: this.disabled(reason, message),
    };
  }

  forContainer(input: ContainerActionPolicyInput): Record<ContainerAction, ActionAvailability> {
    if (input.intentPending) {
      return {
        ...this.allDisabled('intent_pending', 'Another durable intent is pending'),
        delete: this.enabled(),
      };
    }
    if (!input.runtimeReady) {
      return this.allDisabled('server_unreachable', 'Server runtime is not ready');
    }
    if (input.phase === ContainerPhase.Deleting) {
      return this.allDisabled('phase_not_active', 'Container is being deleted');
    }
    if (input.phase === ContainerPhase.Provisioning) {
      return this.allDisabled('phase_not_active', 'Container is not active yet');
    }
    if (input.phase === ContainerPhase.Failed) {
      return {
        ...this.allDisabled('phase_not_active', 'Container is failed'),
        delete: this.enabled(),
      };
    }
    const running = input.runtimeStatus === ContainerStatus.Running;
    const stopped = input.runtimeStatus === ContainerStatus.Stopped;
    return {
      start: stopped
        ? this.enabled()
        : this.disabled('phase_not_active', 'Container is not stopped'),
      stop: running
        ? this.enabled()
        : this.disabled('phase_not_active', 'Container is not running'),
      restart: running
        ? this.enabled()
        : this.disabled('phase_not_active', 'Container is not running'),
      delete: this.enabled(),
      stats: running
        ? this.enabled()
        : this.disabled('phase_not_active', 'Container is not running'),
      console: running && input.sshEnabled
        ? this.enabled()
        : this.disabled('phase_not_active', 'Container console is not ready'),
    };
  }
}
