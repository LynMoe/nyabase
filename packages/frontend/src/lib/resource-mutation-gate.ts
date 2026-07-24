/** A synchronous per-resource gate; React render timing cannot admit a second mutation. */
export interface ResourceMutationGate {
  begin(resourceId: string): boolean;
  end(resourceId: string): void;
  has(resourceId: string): boolean;
  snapshot(): ReadonlySet<string>;
}

export function createResourceMutationGate(): ResourceMutationGate {
  const pending = new Set<string>();
  return {
    begin(resourceId) {
      if (pending.has(resourceId)) return false;
      pending.add(resourceId);
      return true;
    },
    end(resourceId) { pending.delete(resourceId); },
    has(resourceId) { return pending.has(resourceId); },
    snapshot() { return new Set(pending); },
  };
}
