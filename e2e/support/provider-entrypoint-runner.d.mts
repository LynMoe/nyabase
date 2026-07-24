export function runContainerSshProviderEntrypoint(
  entrypoint: string,
  runtimeRoot: string,
  input: unknown,
): Promise<string>;

export function runTopologyFaultProviderEntrypoint(
  entrypoint: string,
  runtimeRoot: string,
  input: unknown,
): Promise<string>;

export function runRecoveryFaultProviderEntrypoint(
  entrypoint: string,
  runtimeRoot: string,
  input: unknown,
): Promise<string>;
