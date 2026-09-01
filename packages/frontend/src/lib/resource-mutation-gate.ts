/** A synchronous per-resource gate; React render timing cannot admit a second mutation. */
export interface ResourceMutationGate {
  begin(resourceId: string): boolean;
  end(resourceId: string): void;
  has(resourceId: string): boolean;
  snapshot(): ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
}

export function createResourceMutationGate(): ResourceMutationGate {
  return createGate();
}

function createGate(): ResourceMutationGate & { reset(): void } {
  let pending = new Set<string>();
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of [...listeners]) listener();
  }

  return {
    begin(resourceId) {
      if (pending.has(resourceId)) return false;
      pending = new Set(pending);
      pending.add(resourceId);
      notify();
      return true;
    },
    end(resourceId) {
      if (!pending.has(resourceId)) return;
      pending = new Set(pending);
      pending.delete(resourceId);
      notify();
    },
    has(resourceId) {
      return pending.has(resourceId);
    },
    snapshot() {
      return pending;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      pending = new Set();
      listeners.clear();
    },
  };
}

const gate = createGate();

export const resourceMutationGate: ResourceMutationGate = gate;

export function resetResourceMutationGateForTests(): void {
  gate.reset();
}

export async function runGatedMutation(
  id: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  if (!resourceMutationGate.begin(id)) return false;
  try {
    await fn();
    return true;
  } finally {
    resourceMutationGate.end(id);
  }
}
