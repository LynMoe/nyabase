export async function eventually<T>(
  load: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 120_000,
  intervalMs = 500,
  label = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  do {
    last = await load();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}
