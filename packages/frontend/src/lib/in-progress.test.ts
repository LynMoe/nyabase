import { describe, expect, it } from 'vitest';
import { ContainerPhase, ContainerStatus, IntentStatus, ResourceLifecyclePhase } from '@nyabase/common';
import type { IntentDto } from '@nyabase/common';
import {
  assignmentInProgress,
  bindInProgress,
  catalogOccupancyPending,
  catalogPgPending,
  containerLifecyclePending,
  containerStatusPending,
  imageInProgress,
  intentListSettled,
  intentPending,
  volumeInProgress,
} from './in-progress.js';

const baseContainer = {
  needsAttention: false,
  lifecyclePhase: ContainerPhase.Active,
  actual: { status: ContainerStatus.Running },
  rootSizePendingBytes: null as number | null,
  observedGeneration: 1 as number | null,
  generation: 1,
};

describe('container progress', () => {
  it('spins both badges while provisioning with an unknown actual status', () => {
    const container = {
      ...baseContainer,
      lifecyclePhase: ContainerPhase.Provisioning,
      actual: { status: ContainerStatus.Unknown },
      observedGeneration: null,
    };
    expect(containerLifecyclePending(container)).toBe(true);
    expect(containerStatusPending(container)).toBe(true);
  });

  it('does not spin an active row whose generation has not been observed', () => {
    const container = { ...baseContainer, observedGeneration: null, rootSizePendingBytes: null };
    expect(containerLifecyclePending(container)).toBe(false);
    expect(containerStatusPending(container)).toBe(false);
  });

  it('spins only the actual-status badge while the root disk is pending', () => {
    const container = { ...baseContainer, rootSizePendingBytes: 1024 };
    expect(containerLifecyclePending(container)).toBe(false);
    expect(containerStatusPending(container)).toBe(true);
  });

  it.each([
    { actual: { status: ContainerStatus.Error }, lifecyclePhase: ContainerPhase.Active, needsAttention: false },
    { actual: { status: ContainerStatus.Running }, lifecyclePhase: ContainerPhase.Failed, needsAttention: false },
    { actual: { status: ContainerStatus.Running }, lifecyclePhase: ContainerPhase.Active, needsAttention: true },
  ])('does not spin when the row is failed even if the root disk is pending', (override) => {
    const container = { ...baseContainer, ...override, rootSizePendingBytes: 1024 };
    expect(containerLifecyclePending(container)).toBe(false);
    expect(containerStatusPending(container)).toBe(false);
  });

  it('spins the actual-status badge when a non-null generation has not caught up', () => {
    const container = { ...baseContainer, observedGeneration: 1, generation: 2 };
    expect(containerStatusPending(container)).toBe(true);
    expect(containerLifecyclePending(container)).toBe(false);
  });
});

describe('other resource progress', () => {
  it('does not treat a null generation on an active volume as in progress', () => {
    expect(volumeInProgress({
      needsAttention: false,
      lifecyclePhase: ResourceLifecyclePhase.Active,
      observedGeneration: null,
      generation: 1,
    })).toBe(false);
  });

  it('treats image progress as deleting only', () => {
    expect(imageInProgress({ deleting: false })).toBe(false);
    expect(imageInProgress({ deleting: true })).toBe(true);
  });

  it('treats an active assignment with a fingerprint mismatch as in progress', () => {
    expect(assignmentInProgress({
      needsAttention: false,
      lifecyclePhase: ResourceLifecyclePhase.Active,
      managedFingerprint: 'aaa',
      observedFingerprint: 'bbb',
    })).toBe(true);
    expect(assignmentInProgress({
      needsAttention: true,
      lifecyclePhase: ResourceLifecyclePhase.Provisioning,
      managedFingerprint: 'aaa',
      observedFingerprint: null,
    })).toBe(false);
  });

  it('treats attaching as in progress and attached as settled', () => {
    expect(bindInProgress('attaching')).toBe(true);
    expect(bindInProgress('attached')).toBe(false);
  });

  it('keeps a clean pending intent unsettled', () => {
    const pending = { status: IntentStatus.Pending, failure: null, failureCode: null } as IntentDto;
    expect(intentPending(pending.status)).toBe(true);
    expect(intentListSettled([pending])).toBe(false);
    expect(intentListSettled([{ ...pending, status: IntentStatus.Succeeded }])).toBe(true);
  });

  it('spins only the PG cell when ensuring overlaps dangling_pg', () => {
    expect(catalogPgPending('ensuring')).toBe(true);
    expect(catalogOccupancyPending('dangling_pg')).toBe(false);
    expect(catalogOccupancyPending('ensuring')).toBe(true);
  });
});
