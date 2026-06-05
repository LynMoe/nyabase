import { describe, expect, it } from 'vitest';
import { ContainerPhase, ContainerStatus } from '@nyabase/common';
import { ContainerActionPolicyService } from '../container-action-policy.service.js';

describe('ContainerActionPolicyService V2', () => {
  const policy = new ContainerActionPolicyService();

  it('blocks every action while an operation is active', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Active,
      runtimeStatus: ContainerStatus.Running,
      runtimeReady: true,
      runtimeDrift: [],
      activeOperationId: 'op-a',
    });
    expect(Object.values(actions).every((a) => !a.enabled && a.reason === 'operation_in_progress')).toBe(true);
  });

  it('derives runtime actions from backend policy for running active containers', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Active,
      runtimeStatus: ContainerStatus.Running,
      runtimeReady: true,
      runtimeDrift: [],
      activeOperationId: null,
    });
    expect(actions.start.enabled).toBe(false);
    expect(actions.stop.enabled).toBe(true);
    expect(actions.restart.enabled).toBe(true);
    expect(actions.console.enabled).toBe(true);
    expect(actions.stats.enabled).toBe(true);
    expect(actions.delete.enabled).toBe(true);
  });

  it('blocks mutating actions while runtime confirmation is pending but keeps running read actions available', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Active,
      runtimeStatus: ContainerStatus.Running,
      runtimeReady: true,
      runtimeDrift: [],
      activeOperationId: null,
      runtimeConfirmationPending: true,
    });
    expect(actions.start.reason).toBe('runtime_confirmation_pending');
    expect(actions.stop.reason).toBe('runtime_confirmation_pending');
    expect(actions.restart.reason).toBe('runtime_confirmation_pending');
    expect(actions.delete.reason).toBe('runtime_confirmation_pending');
    expect(actions.updateMounts.reason).toBe('runtime_confirmation_pending');
    expect(actions.enableSsh.reason).toBe('runtime_confirmation_pending');
    expect(actions.reconcileSsh.reason).toBe('runtime_confirmation_pending');
    expect(actions.stats.enabled).toBe(true);
    expect(actions.console.enabled).toBe(true);
  });

  it('allows deletion but blocks runtime actions for failed containers', () => {
    const actions = policy.forContainer({
      phase: ContainerPhase.Failed,
      runtimeStatus: ContainerStatus.Unknown,
      runtimeReady: true,
      runtimeDrift: [],
      activeOperationId: null,
    });
    expect(actions.delete.enabled).toBe(true);
    expect(actions.start.enabled).toBe(false);
    expect(actions.start.reason).toBe('phase_not_active');
  });
});
