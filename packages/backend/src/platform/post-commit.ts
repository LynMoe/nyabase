import type { Transaction, TransactionBuilder } from 'kysely';

export interface PostCommitLogger {
  warn(message: string): unknown;
}

/**
 * A durable mutation has already committed. Observers such as audit rows,
 * proxy snapshots and cache notifications may be retried independently; they
 * must never turn the committed API outcome into a misleading failure.
 */
export async function postCommitBestEffort(
  label: string,
  work: () => Promise<unknown> | unknown,
  logger: PostCommitLogger = console,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    logger.warn(
      `${label} failed after durable commit: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const afterCommitQueues = new WeakMap<object, Array<() => void>>();

/**
 * Runs `effect` once the transaction that `executor` belongs to has committed.
 * Outside a transaction (including test fakes) it runs immediately. If the
 * transaction rolls back, or is retried, queued effects are discarded.
 * Effects are only flushed by `executeWithPostCommit`, which every
 * transaction that may enqueue one must be started through.
 */
export function afterCommit(
  executor: { readonly isTransaction?: boolean },
  effect: () => void,
): void {
  if (!executor.isTransaction) {
    effect();
    return;
  }
  const queue = afterCommitQueues.get(executor);
  if (queue) queue.push(effect);
  else afterCommitQueues.set(executor, [effect]);
}

/**
 * Executes `work` in a transaction from `builder` and flushes the effects
 * registered with `afterCommit` only after the commit succeeded.
 */
export async function executeWithPostCommit<DB, T>(
  builder: TransactionBuilder<DB>,
  work: (transaction: Transaction<DB>) => Promise<T>,
): Promise<T> {
  let current: Transaction<DB> | undefined;
  const result = await builder.execute((transaction) => {
    current = transaction;
    return work(transaction);
  });
  const queue = current ? afterCommitQueues.get(current) : undefined;
  if (current) afterCommitQueues.delete(current);
  for (const effect of queue ?? []) {
    try {
      effect();
    } catch {
      // A wake is only a latency hint; the worker scan is authoritative.
    }
  }
  return result;
}
