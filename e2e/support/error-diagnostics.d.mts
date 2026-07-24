export interface ErrorDiagnosticOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxEntryChars?: number;
  maxTotalChars?: number;
}

export function sanitizeDiagnosticText(value: unknown, maxChars?: number): string;
export function formatErrorDiagnostics(error: unknown, options?: ErrorDiagnosticOptions): string;
export function runEntrypointWithDiagnostics(
  entrypoint: () => unknown | PromiseLike<unknown>,
  options?: ErrorDiagnosticOptions,
): Promise<void>;
export function aggregateErrorWithDiagnostics(
  description: string,
  errors: Iterable<unknown>,
  options?: ErrorDiagnosticOptions,
): AggregateError;

export interface PrimaryFailure {
  error: unknown;
}

export function runCleanupStepsPreservingPrimary(
  description: string,
  steps: ReadonlyArray<() => Promise<void>>,
  primaryFailure?: PrimaryFailure | null,
): Promise<void>;
