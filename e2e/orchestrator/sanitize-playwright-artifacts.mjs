#!/usr/bin/env node
import { resolve } from 'node:path';

import { sanitizePlaywrightArtifacts } from './playwright-artifact-security.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

if (!process.argv[2]) throw new Error('usage: sanitize-playwright-artifacts.mjs <runtimeDir>');
const runtimeDir = resolve(process.argv[2]);
await loadValidatedRunState(runtimeDir);
const result = await sanitizePlaywrightArtifacts(runtimeDir);
console.log(
  `Playwright artifact normalization PASS: outcome=${result.reportOutcome} `
  + `attachmentsRemoved=${result.attachmentsRemoved} errorContextsRemoved=${result.errorContextsRemoved}`,
);
