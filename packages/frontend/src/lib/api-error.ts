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
