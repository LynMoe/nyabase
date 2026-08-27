export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Parsed response envelope retained for validated conflict snapshots. */
    public body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiErrorCurrent<T>(
  error: unknown,
  code: string,
  validate: (value: unknown) => value is T,
): T | null {
  if (!(error instanceof ApiError) || error.code !== code) return null;
  if (!error.body || typeof error.body !== 'object' || Array.isArray(error.body)) return null;
  const current = (error.body as Record<string, unknown>).current;
  return validate(current) ? current : null;
}

/** Structured `details` from Nest conflict/error envelopes when present. */
export function apiErrorDetails(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError)) return null;
  if (!error.body || typeof error.body !== 'object' || Array.isArray(error.body)) return null;
  const details = (error.body as Record<string, unknown>).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  return details as Record<string, unknown>;
}
