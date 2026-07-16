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
