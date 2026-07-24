import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';

type ModuleLike = {
  name?: string;
  module?: ModuleLike;
  forwardRef?: () => ModuleLike;
};

function unwrapModule(value: ModuleLike): ModuleLike {
  if (typeof value.forwardRef === 'function') return value.forwardRef();
  if (value.module) return value.module;
  return value;
}

describe('production AppModule graph', () => {
  it('contains no undefined imports, including imports hidden by forwardRef', () => {
    const visited = new Set<ModuleLike>();
    const pending: ModuleLike[] = [AppModule as unknown as ModuleLike];

    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, current) as unknown[] | undefined;
      for (const imported of imports ?? []) {
        expect(imported, `${current.name ?? '(anonymous module)'} has an undefined import`).toBeDefined();
        const resolved = unwrapModule(imported as ModuleLike);
        expect(
          resolved,
          `${current.name ?? '(anonymous module)'} has a forwardRef that resolves to undefined`,
        ).toBeDefined();
        pending.push(resolved);
      }
    }

    expect(visited.size).toBeGreaterThan(10);
  });
});
