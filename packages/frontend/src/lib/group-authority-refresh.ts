export type GroupAuthorityRefreshPhase = 'pending' | 'succeeded' | 'failed';

export interface GroupAuthorityRefreshState {
  context: string;
  generation: number;
  groups: GroupAuthorityRefreshPhase;
  actions: GroupAuthorityRefreshPhase;
}

export function createGroupAuthorityRefreshState(context: string): GroupAuthorityRefreshState {
  return {
    context,
    generation: 1,
    groups: 'pending',
    actions: 'pending',
  };
}

/** A principal/capability change is a new authority context even if the local
 * refresh counter happens to be the same. */
export function changeGroupAuthorityContext(
  state: GroupAuthorityRefreshState,
  context: string,
): GroupAuthorityRefreshState {
  if (state.context === context) return state;
  return {
    context,
    generation: state.generation + 1,
    groups: 'pending',
    actions: 'pending',
  };
}

/** Start a new authority snapshot pair and fail closed immediately. */
export function beginGroupAuthorityRefresh(
  state: GroupAuthorityRefreshState,
): GroupAuthorityRefreshState {
  return {
    context: state.context,
    generation: state.generation + 1,
    groups: 'pending',
    actions: 'pending',
  };
}

export function acceptGroupAuthorityGroups(
  state: GroupAuthorityRefreshState,
  context: string,
  generation: number,
): GroupAuthorityRefreshState {
  if (context !== state.context || generation !== state.generation) return state;
  return { ...state, groups: 'succeeded' };
}

export function rejectGroupAuthorityGroups(
  state: GroupAuthorityRefreshState,
  context: string,
  generation: number,
): GroupAuthorityRefreshState {
  if (context !== state.context || generation !== state.generation) return state;
  return { ...state, groups: 'failed', actions: 'pending' };
}

export function acceptGroupAuthorityActions(
  state: GroupAuthorityRefreshState,
  context: string,
  generation: number,
): GroupAuthorityRefreshState {
  if (context !== state.context || generation !== state.generation
    || state.groups !== 'succeeded') return state;
  return { ...state, actions: 'succeeded' };
}

export function rejectGroupAuthorityActions(
  state: GroupAuthorityRefreshState,
  context: string,
  generation: number,
): GroupAuthorityRefreshState {
  if (context !== state.context || generation !== state.generation
    || state.groups !== 'succeeded') return state;
  return { ...state, actions: 'failed' };
}

export function groupAuthorityProjectionReady(state: GroupAuthorityRefreshState): boolean {
  return state.groups === 'succeeded' && state.actions === 'succeeded';
}
