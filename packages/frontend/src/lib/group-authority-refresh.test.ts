import { describe, expect, it } from 'vitest';
import {
  acceptGroupAuthorityActions,
  acceptGroupAuthorityGroups,
  beginGroupAuthorityRefresh,
  changeGroupAuthorityContext,
  createGroupAuthorityRefreshState,
  groupAuthorityProjectionReady,
  rejectGroupAuthorityActions,
  rejectGroupAuthorityGroups,
} from './group-authority-refresh.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('group authority refresh epochs', () => {
  it('accepts actions only after groups from the same epoch succeeded', () => {
    let state = createGroupAuthorityRefreshState('actor-a');
    const epoch = state.epoch;

    state = acceptGroupAuthorityActions(state, 'actor-a', epoch);
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = acceptGroupAuthorityGroups(state, 'actor-a', epoch);
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = acceptGroupAuthorityActions(state, 'actor-a', epoch);
    expect(groupAuthorityProjectionReady(state)).toBe(true);
  });

  it('rejects an old actions response that read first but resolves after a newer group response', () => {
    let state = createGroupAuthorityRefreshState('actor-a');
    const oldEpoch = state.epoch;
    state = acceptGroupAuthorityGroups(state, 'actor-a', oldEpoch);

    state = beginGroupAuthorityRefresh(state);
    const currentRevision = state.epoch;
    state = acceptGroupAuthorityGroups(state, 'actor-a', currentRevision);

    // The old request observed the old DB snapshot, but completed last.
    state = acceptGroupAuthorityActions(state, 'actor-a', oldEpoch);
    expect(state.actions).toBe('pending');
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = acceptGroupAuthorityActions(state, 'actor-a', currentRevision);
    expect(groupAuthorityProjectionReady(state)).toBe(true);
  });

  it('stays closed when a deferred old actions request resolves after the current groups request', async () => {
    let state = createGroupAuthorityRefreshState('actor-a');
    const oldEpoch = state.epoch;
    state = acceptGroupAuthorityGroups(state, 'actor-a', oldEpoch);

    const oldActionsResponse = deferred<void>();
    const oldActionsCompletion = oldActionsResponse.promise.then(() => {
      state = acceptGroupAuthorityActions(state, 'actor-a', oldEpoch);
    });

    state = beginGroupAuthorityRefresh(state);
    const currentRevision = state.epoch;
    const currentGroupsResponse = deferred<void>();
    const currentGroupsCompletion = currentGroupsResponse.promise.then(() => {
      state = acceptGroupAuthorityGroups(state, 'actor-a', currentRevision);
    });

    currentGroupsResponse.resolve();
    await currentGroupsCompletion;
    oldActionsResponse.resolve();
    await oldActionsCompletion;

    expect(state).toMatchObject({
      epoch: currentRevision,
      groups: 'succeeded',
      actions: 'pending',
    });
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = acceptGroupAuthorityActions(state, 'actor-a', currentRevision);
    expect(groupAuthorityProjectionReady(state)).toBe(true);

    const acceptedCurrent = state;
    state = acceptGroupAuthorityActions(state, 'actor-a', oldEpoch);
    expect(state).toBe(acceptedCurrent);
    expect(groupAuthorityProjectionReady(state)).toBe(true);
  });

  it('fails closed for every refresh trigger and for either request failure', () => {
    let state = createGroupAuthorityRefreshState('actor-a');
    state = acceptGroupAuthorityGroups(state, 'actor-a', state.epoch);
    state = acceptGroupAuthorityActions(state, 'actor-a', state.epoch);
    expect(groupAuthorityProjectionReady(state)).toBe(true);

    for (const trigger of ['manual', 'automatic', 'mutation'] as const) {
      void trigger;
      state = beginGroupAuthorityRefresh(state);
      expect(groupAuthorityProjectionReady(state)).toBe(false);
      expect(state).toMatchObject({ groups: 'pending', actions: 'pending' });
      state = acceptGroupAuthorityGroups(state, 'actor-a', state.epoch);
      state = acceptGroupAuthorityActions(state, 'actor-a', state.epoch);
      expect(groupAuthorityProjectionReady(state)).toBe(true);
    }

    state = beginGroupAuthorityRefresh(state);
    state = rejectGroupAuthorityGroups(state, 'actor-a', state.epoch);
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = beginGroupAuthorityRefresh(state);
    state = acceptGroupAuthorityGroups(state, 'actor-a', state.epoch);
    state = rejectGroupAuthorityActions(state, 'actor-a', state.epoch);
    expect(groupAuthorityProjectionReady(state)).toBe(false);
  });

  it('cannot adopt a late response from an older principal or capability context', () => {
    let state = createGroupAuthorityRefreshState('actor-a:ManageGroups');
    const epoch = state.epoch;
    state = acceptGroupAuthorityGroups(state, 'actor-a:ManageGroups', epoch);

    state = changeGroupAuthorityContext(state, 'actor-b:ManageGroups');
    const actorBEpoch = state.epoch;
    state = acceptGroupAuthorityActions(state, 'actor-a:ManageGroups', epoch);
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = acceptGroupAuthorityGroups(state, 'actor-b:ManageGroups', actorBEpoch);
    state = acceptGroupAuthorityActions(state, 'actor-b:ManageGroups', actorBEpoch);
    expect(groupAuthorityProjectionReady(state)).toBe(true);
  });
});
