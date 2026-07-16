import { describe, expect, it } from 'vitest';
import { AgentTaskKind } from '@nyabase/common';
import { createAgentTaskHandlerRegistry } from './index.js';

describe('Agent task handler registry', () => {
  it('has exactly one handler for every durable task kind', () => {
    const registry = createAgentTaskHandlerRegistry({
      config: {} as never,
      docker: {} as never,
      physicalReferenceGuard: {} as never,
      quota: {} as never,
      dataDirs: {} as never,
      remoteFsMounter: {} as never,
      dropbear: {} as never,
      ws: {} as never,
    });
    for (const kind of Object.values(AgentTaskKind)) {
      expect(() => registry.get(kind)).not.toThrow();
    }
  });
});
