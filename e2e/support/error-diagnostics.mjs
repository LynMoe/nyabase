const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_MAX_ENTRY_CHARS = 512;
const DEFAULT_MAX_TOTAL_CHARS = 3_000;
const DIAGNOSTICS_ALREADY_EXPANDED = Symbol('nyabase.diagnosticsAlreadyExpanded');

function boundedPositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function sanitizeDiagnosticText(value, maxChars = DEFAULT_MAX_ENTRY_CHARS) {
  const limit = boundedPositiveInteger(maxChars, DEFAULT_MAX_ENTRY_CHARS);
  let text = String(value ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(
      /-----BEGIN [^-\r\n]{1,64}PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]{1,64}PRIVATE KEY-----/giu,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED JWT]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(
      /(["']?(?:agentToken|accessToken|refreshToken|authorization|password|privateKey|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]*)/giu,
      '$1[REDACTED]',
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length > limit) text = `${text.slice(0, Math.max(0, limit - 14))}…[truncated]`;
  return text || '(no message)';
}

function errorChildren(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return [];
  const children = [];
  if (!error[DIAGNOSTICS_ALREADY_EXPANDED] && Array.isArray(error.errors)) {
    for (const [index, child] of error.errors.entries()) {
      children.push({ label: `errors[${index}]`, value: child });
    }
  }
  if ('cause' in error && error.cause !== undefined) {
    children.push({ label: 'cause', value: error.cause });
  }
  return children;
}

/** Flatten nested Error.cause/AggregateError.errors for top-level reports. */
export function formatErrorDiagnostics(error, options = {}) {
  const maxDepth = boundedPositiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const maxEntries = boundedPositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxEntryChars = boundedPositiveInteger(options.maxEntryChars, DEFAULT_MAX_ENTRY_CHARS);
  const maxTotalChars = boundedPositiveInteger(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS);
  const entries = [];
  const seen = new WeakSet();

  const visit = (value, path, depth) => {
    if (entries.length >= maxEntries) return;
    if (depth > maxDepth) {
      entries.push(`${path} [depth limit]`);
      return;
    }
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      if (seen.has(value)) {
        entries.push(`${path} [cycle]`);
        return;
      }
      seen.add(value);
    }
    const name =
      value && typeof value === 'object' && typeof value.name === 'string'
        ? sanitizeDiagnosticText(value.name, 80)
        : 'Error';
    const message =
      value && typeof value === 'object' && 'message' in value ? value.message : value;
    entries.push(`${path} ${name}: ${sanitizeDiagnosticText(message, maxEntryChars)}`);
    for (const child of errorChildren(value)) {
      if (entries.length >= maxEntries) break;
      visit(child.value, `${path}.${child.label}`, depth + 1);
    }
  };

  visit(error, 'root', 0);
  if (entries.length >= maxEntries) entries.push('[entry limit reached]');
  const joined = entries.join(' | ');
  if (joined.length <= maxTotalChars) return joined;
  return `${joined.slice(0, Math.max(0, maxTotalChars - 18))}…[chain truncated]`;
}

/** Run a process entrypoint without exposing Node's raw uncaught-error rendering. */
export async function runEntrypointWithDiagnostics(entrypoint, options = {}) {
  try {
    await entrypoint();
  } catch (error) {
    process.exitCode = 1;
    let diagnostic;
    try {
      diagnostic = formatErrorDiagnostics(error, options);
    } catch {
      try {
        diagnostic = formatErrorDiagnostics(new Error('entrypoint failed; diagnostic unavailable'));
      } catch {
        return;
      }
    }
    try {
      process.stderr.write(`${diagnostic}\n`);
    } catch {
      // Keep the original failure handled when the diagnostic stream is unavailable.
    }
  }
}

export function aggregateErrorWithDiagnostics(description, errors, options = {}) {
  const normalized = [...errors].map((error) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  const detail = normalized
    .map((error, index) => `failure[${index + 1}] ${formatErrorDiagnostics(error, options)}`)
    .join(' | ');
  const message = sanitizeDiagnosticText(
    `${description}: ${detail}`,
    boundedPositiveInteger(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS),
  );
  const aggregate = new AggregateError(normalized, message);
  Object.defineProperty(aggregate, DIAGNOSTICS_ALREADY_EXPANDED, { value: true });
  return aggregate;
}

/**
 * Run every cleanup step while preserving a scenario failure, including the
 * legal JavaScript value `undefined`. Use an explicit wrapper instead of an
 * undefined sentinel so no thrown value can be mistaken for success.
 */
export async function runCleanupStepsPreservingPrimary(
  description,
  steps,
  primaryFailure = null,
) {
  const cleanupFailures = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (primaryFailure !== null && cleanupFailures.length > 0) {
    throw aggregateErrorWithDiagnostics(
      `${description}; scenario and cleanup both failed`,
      [primaryFailure.error, ...cleanupFailures],
    );
  }
  if (primaryFailure !== null) throw primaryFailure.error;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw aggregateErrorWithDiagnostics(description, cleanupFailures);
  }
}
