export function requireRuntimeEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`E2E runtime is BLOCKED: required input ${name} is missing`);
  }
  return value;
}

export function currentRunId(): string {
  const runId = requireRuntimeEnv('E2E_RUN_ID');
  if (!/^[a-z0-9][a-z0-9-]{5,63}$/.test(runId)) {
    throw new Error(`E2E_RUN_ID is not a safe resource prefix: ${runId}`);
  }
  return runId;
}
