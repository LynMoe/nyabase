import { describe, expect, it } from 'vitest';
import { ContainerPhase, ContainerStatus, RuntimeDriftKind } from '@nyabase/common';
import { ContainerActionPolicyService } from '../container-action-policy.service.js';

describe('ContainerActionPolicyService', () => {
  const policy = new ContainerActionPolicyService();

  it('blocks mutation and console while a task is pending but keeps stats available', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Active,
      runtimeStatus: ContainerStatus.Running,
      runtimeReady: true,
      runtimeDrift: [],
      activeTaskId: 'task-a',
      sshEnabled: true,
    });
    expect(actions.start.reason).toBe('task_in_progress');
    expect(actions.stop.reason).toBe('task_in_progress');
    expect(actions.restart.reason).toBe('task_in_progress');
    expect(actions.delete.reason).toBe('task_in_progress');
    expect(actions.updateMounts.reason).toBe('task_in_progress');
    expect(actions.reconcileSsh.reason).toBe('task_in_progress');
    expect(actions.stats.enabled).toBe(true);
    expect(actions.console.reason).toBe('task_in_progress');
  });

  it('derives runtime actions from backend policy for running active containers', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Active,
      runtimeStatus: ContainerStatus.Running,
      runtimeReady: true,
      runtimeDrift: [],
      activeTaskId: null,
      sshEnabled: true,
    });
    expect(actions.start.enabled).toBe(false);
    expect(actions.stop.enabled).toBe(true);
    expect(actions.restart.enabled).toBe(true);
    expect(actions.console.enabled).toBe(true);
    expect(actions.stats.enabled).toBe(true);
    expect(actions.delete.enabled).toBe(true);
    expect(actions.reconcileSsh.enabled).toBe(true);
  });

  it('blocks SSH repair when the image disables SSH', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Active,
      runtimeStatus: ContainerStatus.Running,
      runtimeReady: true,
      runtimeDrift: [],
      activeTaskId: null,
      sshEnabled: false,
    });
    expect(actions.reconcileSsh.enabled).toBe(false);
    expect(actions.reconcileSsh.reason).toBe('image_not_available');
  });

  it('allows deletion but blocks runtime actions for failed containers', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Failed,
      runtimeStatus: ContainerStatus.Unknown,
      runtimeReady: true,
      runtimeDrift: [],
      activeTaskId: null,
      sshEnabled: true,
    });
    expect(actions.delete.enabled).toBe(true);
    expect(actions.start.enabled).toBe(false);
    expect(actions.start.reason).toBe('phase_not_active');
  });

  it('allows start to recover desired-running power drift after a host reboot', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Active,
      runtimeStatus: ContainerStatus.Exited,
      runtimeReady: true,
      runtimeDrift: [{
        kind: RuntimeDriftKind.PowerIntentMismatch,
        desired: 'running',
        observed: 'exited',
      }],
      activeTaskId: null,
      sshEnabled: true,
    });
    expect(actions.start.enabled).toBe(true);
    expect(actions.delete.enabled).toBe(true);
  });

  it('allows stop to recover desired-stopped power drift', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Active,
      runtimeStatus: ContainerStatus.Running,
      runtimeReady: true,
      runtimeDrift: [{
        kind: RuntimeDriftKind.PowerIntentMismatch,
        desired: 'stopped',
        observed: 'running',
      }],
      activeTaskId: null,
      sshEnabled: true,
    });
    expect(actions.stop.enabled).toBe(true);
    expect(actions.start.enabled).toBe(false);
  });

  it('blocks mount-consuming starts but retains safe stop/delete for corrupt durable mounts', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Active,
      runtimeStatus: ContainerStatus.Running,
      runtimeReady: true,
      runtimeDrift: [{ kind: RuntimeDriftKind.DesiredMountSpecInvalid }],
      activeTaskId: null,
      sshEnabled: true,
    });
    expect(actions.restart.enabled).toBe(false);
    expect(actions.restart.message).toMatch(/mount configuration is invalid/);
    expect(actions.stop.enabled).toBe(true);
    expect(actions.delete.enabled).toBe(true);
  });
});
