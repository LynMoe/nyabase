export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isJsonObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isJsonObject(value) ? value : {};
}
