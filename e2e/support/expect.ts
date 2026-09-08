type Matcher = { readonly __expect: string; readonly value?: unknown };

function isMatcher(value: unknown): value is Matcher {
  return Boolean(value) && typeof value === 'object' && '__expect' in (value as object);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function matches(actual: unknown, expected: unknown): boolean {
  if (isMatcher(expected)) {
    if (expected.__expect === 'any') {
      const ctor = expected.value as new (...args: never[]) => unknown;
      if (ctor === Number) return typeof actual === 'number' && !Number.isNaN(actual);
      if (ctor === String) return typeof actual === 'string';
      if (ctor === Boolean) return typeof actual === 'boolean';
      return actual instanceof ctor;
    }
    if (expected.__expect === 'arrayContaining') {
      if (!Array.isArray(actual)) return false;
      return (expected.value as unknown[]).every((entry) => (
        actual.some((candidate) => matches(candidate, entry))
      ));
    }
    if (expected.__expect === 'objectContaining') {
      if (actual === null || typeof actual !== 'object') return false;
      const expectedRecord = expected.value as Record<string, unknown>;
      const actualRecord = actual as Record<string, unknown>;
      return Object.keys(expectedRecord).every((key) => {
        if (!Object.prototype.hasOwnProperty.call(actualRecord, key)) return false;
        const wanted = expectedRecord[key];
        const nested = wanted !== null
          && typeof wanted === 'object'
          && !Array.isArray(wanted)
          && !isMatcher(wanted)
          && !(wanted instanceof RegExp);
        return matches(
          actualRecord[key],
          nested ? { __expect: 'objectContaining', value: wanted } : wanted,
        );
      });
    }
  }
  if (expected === null || actual === null) return actual === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((entry, index) => matches(actual[index], entry));
  }
  if (typeof expected === 'object' && typeof actual === 'object') {
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const keys = Object.keys(expectedRecord);
    if (keys.length !== Object.keys(actualRecord).length) return false;
    return keys.every((key) => matches(actualRecord[key], expectedRecord[key]));
  }
  if (expected instanceof RegExp && typeof actual === 'string') return expected.test(actual);
  return Object.is(actual, expected);
}

function fail(message: string): never {
  throw new Error(message);
}

export function expect(actual: unknown, message?: string) {
  const prefix = message ? `${message}: ` : '';
  const self = {
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) {
        fail(`${prefix}expected ${stringify(expected)}, got ${stringify(actual)}`);
      }
    },
    toEqual(expected: unknown) {
      if (!matches(actual, expected)) {
        fail(`${prefix}expected ${stringify(expected)}, got ${stringify(actual)}`);
      }
    },
    toMatch(expected: RegExp | string) {
      const text = String(actual ?? '');
      const ok = typeof expected === 'string' ? text.includes(expected) : expected.test(text);
      if (!ok) fail(`${prefix}${stringify(actual)} does not match ${String(expected)}`);
    },
    toContain(expected: unknown) {
      if (typeof actual === 'string') {
        if (!actual.includes(String(expected))) {
          fail(`${prefix}${stringify(actual)} does not contain ${stringify(expected)}`);
        }
        return;
      }
      if (Array.isArray(actual)) {
        if (!actual.some((entry) => matches(entry, expected) || Object.is(entry, expected))) {
          fail(`${prefix}${stringify(actual)} does not contain ${stringify(expected)}`);
        }
        return;
      }
      fail(`${prefix}cannot call toContain on ${stringify(actual)}`);
    },
    toHaveLength(length: number) {
      const actualLength = (actual as { length?: number })?.length;
      if (actualLength !== length) {
        fail(`${prefix}expected length ${length}, got ${String(actualLength)}`);
      }
    },
    toBeTruthy() {
      if (!actual) fail(`${prefix}expected truthy, got ${stringify(actual)}`);
    },
    toBeDefined() {
      if (actual === undefined) fail(`${prefix}expected defined value`);
    },
    toBeUndefined() {
      if (actual !== undefined) fail(`${prefix}expected undefined, got ${stringify(actual)}`);
    },
    toBeNull() {
      if (actual !== null) fail(`${prefix}expected null, got ${stringify(actual)}`);
    },
    toBeFalsy() {
      if (actual) fail(`${prefix}expected falsy, got ${stringify(actual)}`);
    },
    toBeGreaterThan(expected: number) {
      if (!(typeof actual === 'number' && actual > expected)) {
        fail(`${prefix}expected ${stringify(actual)} > ${expected}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number) {
      if (!(typeof actual === 'number' && actual >= expected)) {
        fail(`${prefix}expected ${stringify(actual)} >= ${expected}`);
      }
    },
    toBeLessThan(expected: number) {
      if (!(typeof actual === 'number' && actual < expected)) {
        fail(`${prefix}expected ${stringify(actual)} < ${expected}`);
      }
    },
    toBeLessThanOrEqual(expected: number) {
      if (!(typeof actual === 'number' && actual <= expected)) {
        fail(`${prefix}expected ${stringify(actual)} <= ${expected}`);
      }
    },
    toMatchObject(expected: Record<string, unknown>) {
      if (!matches(actual, { __expect: 'objectContaining', value: expected })) {
        fail(`${prefix}expected ${stringify(actual)} to match ${stringify(expected)}`);
      }
    },
    toHaveProperty(key: string) {
      if (actual === null || typeof actual !== 'object' || !(key in actual)) {
        fail(`${prefix}expected property ${key} on ${stringify(actual)}`);
      }
    },
    get not() {
      return {
        toBe(expected: unknown) {
          if (Object.is(actual, expected)) {
            fail(`${prefix}expected not ${stringify(expected)}`);
          }
        },
        toHaveProperty(key: string) {
          if (actual !== null && typeof actual === 'object' && key in actual) {
            fail(`${prefix}did not expect property ${key}`);
          }
        },
        toContain(expected: unknown) {
          if (typeof actual === 'string' && actual.includes(String(expected))) {
            fail(`${prefix}did not expect ${stringify(actual)} to contain ${stringify(expected)}`);
          }
          if (Array.isArray(actual) && actual.some((entry) => Object.is(entry, expected))) {
            fail(`${prefix}did not expect ${stringify(actual)} to contain ${stringify(expected)}`);
          }
        },
        toBeUndefined() {
          if (actual === undefined) fail(`${prefix}did not expect undefined`);
        },
      };
    },
  };
  return self;
}

expect.any = (ctor: unknown): Matcher => ({ __expect: 'any', value: ctor });
expect.arrayContaining = (value: unknown[]): Matcher => ({ __expect: 'arrayContaining', value });
expect.objectContaining = (value: Record<string, unknown>): Matcher => (
  { __expect: 'objectContaining', value }
);

expect.poll = (
  load: () => unknown | Promise<unknown>,
  options: { timeout?: number } = {},
) => ({
  async toBe(expected: unknown) {
    const timeout = options.timeout ?? 15_000;
    const deadline = Date.now() + timeout;
    let last: unknown;
    while (Date.now() < deadline) {
      last = await load();
      if (Object.is(last, expected)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    fail(`poll timed out after ${timeout}ms: expected ${stringify(expected)}, got ${stringify(last)}`);
  },
});
