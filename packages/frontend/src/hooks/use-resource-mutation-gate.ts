import { useSyncExternalStore } from 'react';
import { resourceMutationGate } from '../lib/resource-mutation-gate.js';

function subscribe(onStoreChange: () => void): () => void {
  return resourceMutationGate.subscribe(onStoreChange);
}

export function useResourceMutationPending(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => resourceMutationGate.has(id),
    () => resourceMutationGate.has(id),
  );
}
