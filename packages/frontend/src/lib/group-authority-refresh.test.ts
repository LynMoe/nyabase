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

describe('group authority refresh generations', () => {
  it('accepts actions only after groups from the same generation succeeded', () => {
    let state = createGroupAuthorityRefreshState('actor-a');
    const generation = state.generation;

    state = acceptGroupAuthorityActions(state, 'actor-a', generation);
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = acceptGroupAuthorityGroups(state, 'actor-a', generation);
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = acceptGroupAuthorityActions(state, 'actor-a', generation);
    expect(groupAuthorityProjectionReady(state)).toBe(true);
  });

  it('rejects an old actions response that read first but resolves after a newer group response', () => {
    let state = createGroupAuthorityRefreshState('actor-a');
    const oldGeneration = state.generation;
    state = acceptGroupAuthorityGroups(state, 'actor-a', oldGeneration);

    state = beginGroupAuthorityRefresh(state);
    const currentGeneration = state.generation;
    state = acceptGroupAuthorityGroups(state, 'actor-a', currentGeneration);

    // The old request observed the old DB snapshot, but completed last.
    state = acceptGroupAuthorityActions(state, 'actor-a', oldGeneration);
    expect(state.actions).toBe('pending');
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = acceptGroupAuthorityActions(state, 'actor-a', currentGeneration);
    expect(groupAuthorityProjectionReady(state)).toBe(true);
  });

  it('stays closed when a deferred old actions request resolves after the current groups request', async () => {
    let state = createGroupAuthorityRefreshState('actor-a');
    const oldGeneration = state.generation;
    state = acceptGroupAuthorityGroups(state, 'actor-a', oldGeneration);

    const oldActionsResponse = deferred<void>();
    const oldActionsCompletion = oldActionsResponse.promise.then(() => {
      state = acceptGroupAuthorityActions(state, 'actor-a', oldGeneration);
    });

    state = beginGroupAuthorityRefresh(state);
    const currentGeneration = state.generation;
    const currentGroupsResponse = deferred<void>();
    const currentGroupsCompletion = currentGroupsResponse.promise.then(() => {
      state = acceptGroupAuthorityGroups(state, 'actor-a', currentGeneration);
    });

    currentGroupsResponse.resolve();
    await currentGroupsCompletion;
    oldActionsResponse.resolve();
    await oldActionsCompletion;

    expect(state).toMatchObject({
      generation: currentGeneration,
      groups: 'succeeded',
      actions: 'pending',
    });
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = acceptGroupAuthorityActions(state, 'actor-a', currentGeneration);
    expect(groupAuthorityProjectionReady(state)).toBe(true);

    const acceptedCurrent = state;
    state = acceptGroupAuthorityActions(state, 'actor-a', oldGeneration);
    expect(state).toBe(acceptedCurrent);
    expect(groupAuthorityProjectionReady(state)).toBe(true);
  });

  it('fails closed for every refresh trigger and for either request failure', () => {
    let state = createGroupAuthorityRefreshState('actor-a');
    state = acceptGroupAuthorityGroups(state, 'actor-a', state.generation);
    state = acceptGroupAuthorityActions(state, 'actor-a', state.generation);
    expect(groupAuthorityProjectionReady(state)).toBe(true);

    for (const trigger of ['manual', 'automatic', 'mutation'] as const) {
      void trigger;
      state = beginGroupAuthorityRefresh(state);
      expect(groupAuthorityProjectionReady(state)).toBe(false);
      expect(state).toMatchObject({ groups: 'pending', actions: 'pending' });
      state = acceptGroupAuthorityGroups(state, 'actor-a', state.generation);
      state = acceptGroupAuthorityActions(state, 'actor-a', state.generation);
      expect(groupAuthorityProjectionReady(state)).toBe(true);
    }

    state = beginGroupAuthorityRefresh(state);
    state = rejectGroupAuthorityGroups(state, 'actor-a', state.generation);
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = beginGroupAuthorityRefresh(state);
    state = acceptGroupAuthorityGroups(state, 'actor-a', state.generation);
    state = rejectGroupAuthorityActions(state, 'actor-a', state.generation);
    expect(groupAuthorityProjectionReady(state)).toBe(false);
  });

  it('cannot adopt a late response from an older principal or capability context', () => {
    let state = createGroupAuthorityRefreshState('actor-a:ManageGroups');
    const generation = state.generation;
    state = acceptGroupAuthorityGroups(state, 'actor-a:ManageGroups', generation);

    state = changeGroupAuthorityContext(state, 'actor-b:ManageGroups');
    const actorBGeneration = state.generation;
    state = acceptGroupAuthorityActions(state, 'actor-a:ManageGroups', generation);
    expect(groupAuthorityProjectionReady(state)).toBe(false);

    state = acceptGroupAuthorityGroups(state, 'actor-b:ManageGroups', actorBGeneration);
    state = acceptGroupAuthorityActions(state, 'actor-b:ManageGroups', actorBGeneration);
    expect(groupAuthorityProjectionReady(state)).toBe(true);
  });
});
