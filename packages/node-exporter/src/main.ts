import {
  collectNvidiaGpuMetrics,
  NVIDIA_GPU_LABEL_VALIDATORS,
  NVIDIA_GPU_METRIC_DEFINITIONS,
} from '@nyabase/nvidia-gpu';
import {
  CORE_LABEL_VALIDATORS,
  mergeNodeMetricCatalog,
  NODE_METRIC_DEFINITIONS,
} from '@nyabase/common';
import { LinuxNodeMetricsCollector } from './collector.js';
import { loadNodeExporterConfig } from './config.js';
import { createNodeExporterServer } from './server.js';

async function main(): Promise<void> {
  const config = await loadNodeExporterConfig();
  const catalog = mergeNodeMetricCatalog(
    { definitions: NODE_METRIC_DEFINITIONS, validators: CORE_LABEL_VALIDATORS },
    { definitions: NVIDIA_GPU_METRIC_DEFINITIONS, validators: NVIDIA_GPU_LABEL_VALIDATORS },
  );
  const collector = new LinuxNodeMetricsCollector({
    parentInterface: config.parentInterface,
    extraCollectors: [collectNvidiaGpuMetrics],
  });
  const server = createNodeExporterServer({
    token: config.token,
    key: config.tlsKey,
    cert: config.tlsCertificate,
    collector,
    catalog,
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
