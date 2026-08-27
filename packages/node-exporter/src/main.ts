import { LinuxNodeMetricsCollector } from './collector.js';
import { loadNodeExporterConfig } from './config.js';
import { createNodeExporterServer } from './server.js';

async function main(): Promise<void> {
  const config = await loadNodeExporterConfig();
  const collector = new LinuxNodeMetricsCollector({
    parentInterface: config.parentInterface,
  });
  const server = createNodeExporterServer({
    token: config.token,
    key: config.tlsKey,
    cert: config.tlsCertificate,
    collector,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  console.log(`[nyabase-node] HTTPS metrics listening on ${config.host}:${config.port}/metrics`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(
    '[nyabase-node] Failed to start:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
