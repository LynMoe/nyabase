import { readFile } from 'node:fs/promises';

export interface NodeExporterConfig {
  readonly token: string;
  readonly tlsKey: string | Buffer;
  readonly tlsCertificate: string | Buffer;
  readonly host: string;
  readonly port: number;
  readonly parentInterface?: string;
}

export async function loadNodeExporterConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NodeExporterConfig> {
  const token = required(environment.NODE_EXPORTER_TOKEN, 'NODE_EXPORTER_TOKEN');
  if (token.length < 32 || token.length > 1024 || /[\u0000-\u001f\u007f\s]/.test(token)) {
    throw new Error('NODE_EXPORTER_TOKEN must be a bounded non-whitespace secret');
  }
  const keyPath = required(environment.NODE_EXPORTER_TLS_KEY, 'NODE_EXPORTER_TLS_KEY');
  const certificatePath = required(
    environment.NODE_EXPORTER_TLS_CERT,
    'NODE_EXPORTER_TLS_CERT',
  );
  const port = parsePort(environment.NODE_EXPORTER_PORT ?? '9109');
  const host = environment.NODE_EXPORTER_HOST?.trim() || '0.0.0.0';
  const parentInterface = environment.NODE_EXPORTER_PARENT_INTERFACE?.trim() || undefined;
  if (parentInterface && !/^[A-Za-z0-9_.:-]{1,64}$/.test(parentInterface)) {
    throw new Error('NODE_EXPORTER_PARENT_INTERFACE is invalid');
  }
  return {
    token,
    tlsKey: await readFile(keyPath),
    tlsCertificate: await readFile(certificatePath),
    host,
    port,
    parentInterface,
  };
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('NODE_EXPORTER_PORT is invalid');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('NODE_EXPORTER_PORT is invalid');
  }
  return port;
}
