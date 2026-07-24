import { writeFileSync } from 'node:fs';

const [output, runId] = process.argv.slice(2);
if (!output || !runId) throw new Error('output and run id are required');
writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  runId,
  recordedAt: new Date().toISOString(),
  containers: 0,
  networks: 0,
  images: 0,
  privateDirectoryRemoved: true,
  labelScoped: true,
}, null, 2)}\n`);
