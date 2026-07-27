#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFullRunChainArtifact } from '../orchestrator/full-run-chain.mjs';
import { assertCleanManifest, manifestSchemaVersion } from '../orchestrator/manifest-contract.mjs';
import { behavioralClosureLabel, parseValidationMode } from './validation-mode.mjs';

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(e2eRoot, '..');
const ledgerPath = join(e2eRoot, 'coverage', 'features.yaml');
const failures = [];
const validationMode = parseValidationMode(process.argv.slice(2));
const { requiredProfile, evidenceValue, fullChainCandidate } = validationMode;
const fullChainCaseId = 'cleanup.release-evidence.two-consecutive-cold-full-runs';

function fail(message) {
  failures.push(message);
}

for (const validationFailure of validationMode.failures) fail(validationFailure);

// The new framework is the sole product E2E owner. Keep deletion of the
// fixed-host live probes and mocked frontend visual suite enforceable instead
// of relying on a one-time worktree cleanup.
const retiredFrameworkPaths = [
  'test',
  'packages/frontend/e2e',
  'packages/frontend/playwright.config.ts',
  'scripts/check-visual.sh',
];
for (const retiredPath of retiredFrameworkPaths) {
  if (existsSync(join(repoRoot, retiredPath))) {
    fail(`retired E2E/visual framework path must remain absent: ${retiredPath}`);
  }
}

try {
  execFileSync(
    process.execPath,
    [join(e2eRoot, 'coverage', 'apply-profile-contract.mjs'), '--check'],
    {
      cwd: e2eRoot,
      stdio: 'pipe',
    },
  );
} catch (error) {
  fail(`coverage profile contract is stale: ${error.stderr?.toString().trim() || error.message}`);
}

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} must remain JSON-compatible YAML/JSON: ${error.message}`);
  }
}

for (const [packagePath, forbiddenScripts, forbiddenDependencies] of [
  ['package.json', ['check-visual'], []],
  [
    'packages/frontend/package.json',
    ['test:e2e', 'test:e2e:update'],
    ['@playwright/test', 'playwright'],
  ],
]) {
  const packageJson = readJson(join(repoRoot, packagePath), packagePath);
  for (const script of forbiddenScripts) {
    if (Object.hasOwn(packageJson.scripts ?? {}, script)) {
      fail(`retired E2E/visual package script must remain absent: ${packagePath}#${script}`);
    }
  }
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  for (const dependency of forbiddenDependencies) {
    if (Object.hasOwn(dependencies, dependency)) {
      fail(`retired frontend visual dependency must remain absent: ${packagePath}#${dependency}`);
    }
  }
}

function walk(root, ignored = new Set()) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path, ignored) : [path];
  });
}

function slash(path) {
  return path.split(sep).join('/');
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function sha256Command(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hash = createHash('sha256');
    let stderr = '';
    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 65536) stderr += chunk.toString('utf8');
    });
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise(hash.digest('hex'));
        return;
      }
      rejectPromise(
        new Error(`${command} exited with ${code ?? `signal ${signal}`}: ${stderr.trim()}`),
      );
    });
  });
}

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function assertBaseline(name, actual, expected) {
  if (actual !== expected) fail(`${name} drifted: expected ${expected}, found ${actual}`);
}

function validateExactOwnership(label, actualItems, rows, field) {
  const owners = new Map();
  for (const row of rows) {
    for (const item of row[field] ?? []) {
      const prior = owners.get(item);
      if (prior) fail(`${label} ${item} is mapped by both ${prior} and ${row.id}`);
      else owners.set(item, row.id);
    }
  }
  const actual = new Set(actualItems);
  for (const item of actual)
    if (!owners.has(item)) fail(`${label} ${item} is not mapped in features.yaml`);
  for (const item of owners.keys())
    if (!actual.has(item)) fail(`${label} ${item} is stale in features.yaml`);
}

const ledger = readJson(ledgerPath, 'features.yaml');
if (ledger.schemaVersion !== 2) fail('features.yaml schemaVersion must be 2');
if (ledger.scope !== 'cpu-only') fail('features.yaml scope must be cpu-only');
if (!Array.isArray(ledger.features) || ledger.features.length === 0) {
  fail('features.yaml must contain feature rows');
}
if ('maturityDefinition' in ledger)
  fail('features.yaml must not contain manual maturityDefinition');
const features = Array.isArray(ledger.features) ? ledger.features : [];

const controllerRoot = join(repoRoot, 'packages', 'backend', 'src');
const controllerFiles = walk(controllerRoot)
  .filter((path) => path.endsWith('.controller.ts'))
  .sort();
const decoratorPattern = /@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(/g;
const httpDecorators = controllerFiles.reduce(
  (total, path) => total + [...readFileSync(path, 'utf8').matchAll(decoratorPattern)].length,
  0,
);
const httpSurfaces = controllerFiles
  .flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    const controller = source.match(/@Controller\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/);
    const controllerFile = slash(relative(controllerRoot, path));
    if (!controller) {
      fail(`Could not derive @Controller path from ${controllerFile}`);
      return [];
    }
    return [
      ...source.matchAll(
        /@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/g,
      ),
    ].map((match) => {
      const apiPath = ['api', controller[1] ?? '', match[2] ?? ''].filter(Boolean).join('/');
      return `${controllerFile}|${match[1].toUpperCase()}|/${apiPath}`;
    });
  })
  .sort();
if (new Set(httpSurfaces).size !== httpSurfaces.length) {
  fail('source contains duplicate exact controllerFile|METHOD|/api/path surfaces');
}
const httpInventorySha256 = sha256Buffer(`${httpSurfaces.join('\n')}\n`);

const routeRoot = join(repoRoot, 'packages', 'frontend', 'src', 'routes');
const routeFiles = walk(routeRoot)
  .filter((path) => path.endsWith('.tsx'))
  .map((path) => slash(relative(routeRoot, path)))
  .sort();

const enumsSource = readFileSync(join(repoRoot, 'packages', 'common', 'src', 'enums.ts'), 'utf8');
const taskEnum = enumsSource.match(/export enum AgentTaskKind\s*{([\s\S]*?)\n}/);
if (!taskEnum) fail('Could not derive AgentTaskKind from packages/common/src/enums.ts');
const agentTaskKinds = taskEnum
  ? [...taskEnum[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*['"][^'"]+['"],?\s*$/gm)]
      .map((match) => match[1])
      .sort()
  : [];

const backendMain = readFileSync(join(repoRoot, 'packages', 'backend', 'src', 'main.ts'), 'utf8');
const websocketPaths = [
  ...new Set([...backendMain.matchAll(/['"](\/ws\/[a-z0-9-]+)['"]/g)].map((match) => match[1])),
].sort();

const requiredBaseline = {
  httpDecorators: 154,
  httpControllerFiles: 30,
  frontendRouteFiles: 20,
  agentTaskKinds: 14,
  websocketPaths: 4,
  httpInventorySha256: 'ddcd75ceec7bcfd4f69ee090b1455b063e318f3fde0ac8a87159ce9871643871',
};
for (const [name, required] of Object.entries(requiredBaseline)) {
  if (ledger.baseline?.[name] !== required) {
    fail(`features.yaml baseline ${name} must explicitly be ${required}`);
  }
}
assertBaseline('HTTP decorator inventory', httpDecorators, ledger.baseline?.httpDecorators);
assertBaseline(
  'exact HTTP method/path inventory',
  httpInventorySha256,
  ledger.baseline?.httpInventorySha256,
);
assertBaseline(
  'HTTP controller inventory',
  controllerFiles.length,
  ledger.baseline?.httpControllerFiles,
);
assertBaseline('frontend route inventory', routeFiles.length, ledger.baseline?.frontendRouteFiles);
assertBaseline('AgentTaskKind inventory', agentTaskKinds.length, ledger.baseline?.agentTaskKinds);
assertBaseline('WebSocket path inventory', websocketPaths.length, ledger.baseline?.websocketPaths);

validateExactOwnership('exact HTTP surface', httpSurfaces, features, 'httpSurfaces');
validateExactOwnership('frontend route', routeFiles, features, 'uiRoutes');
validateExactOwnership('AgentTaskKind', agentTaskKinds, features, 'agentTasks');
validateExactOwnership('WebSocket path', websocketPaths, features, 'websockets');

const knownLayers = new Set([
  '00-foundation',
  '10-auth-rbac',
  '20-servers-images',
  '30-containers',
  '40-storage-quota',
  '50-proxies-network',
  '60-metrics-audit-settings',
  '70-browser',
  '80-recovery-security',
  '90-cleanup-evidence',
]);
const knownProfiles = new Map();
for (const name of ['smoke', 'core', 'full', 'recovery']) {
  const profile = readJson(join(e2eRoot, 'profiles', `${name}.yaml`), `profile ${name}`);
  knownProfiles.set(name, profile);
  if (profile.name !== name) fail(`profile ${name} has mismatched name ${profile.name}`);
  if (profile.cpuOnly !== true) fail(`profile ${name} must be CPU-only`);
  if (!Array.isArray(profile.groups) || profile.groups.length === 0) {
    fail(`profile ${name} must select groups`);
  }
  if (new Set(profile.groups).size !== profile.groups.length)
    fail(`profile ${name} contains duplicate groups`);
  for (const group of profile.groups ?? []) {
    if (!knownLayers.has(group)) fail(`profile ${name} references unknown group ${group}`);
  }
  if (!Array.isArray(profile.requiredEnv) || !profile.requiredEnv.includes('E2E_RUN_ID')) {
    fail(`profile ${name} must require E2E_RUN_ID`);
  }
  if (!profile.requiredEnv?.includes('E2E_EDGE_SPKI')) {
    fail(`profile ${name} must require the per-run edge SPKI pin`);
  }
}

const featureIds = new Set();
const caseIds = new Set();
const caseById = new Map();
const featureByCaseId = new Map();
const referencedSpecs = new Set();
const declaredSpecTestIds = new Map();
const caseSurfaceOwners = new Map();

for (const feature of features) {
  if (typeof feature.id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(feature.id)) {
    fail(`invalid feature id ${String(feature.id)}`);
  } else if (featureIds.has(feature.id)) fail(`duplicate feature id ${feature.id}`);
  else featureIds.add(feature.id);
  if ('maturity' in feature) fail(`${feature.id} must not declare manual maturity`);
  if (!knownLayers.has(feature.layer)) fail(`${feature.id} uses unknown layer ${feature.layer}`);
  for (const field of ['owner', 'group']) {
    if (typeof feature[field] !== 'string' || feature[field].length === 0)
      fail(`${feature.id} must declare ${field}`);
  }
  for (const field of [
    'profiles',
    'specs',
    'cases',
    'httpSurfaces',
    'uiRoutes',
    'agentTasks',
    'websockets',
  ]) {
    if (!Array.isArray(feature[field])) fail(`${feature.id} must declare array ${field}`);
  }
  if (!feature.profiles?.length || !feature.specs?.length || !feature.cases?.length) {
    fail(`${feature.id} must declare non-empty profiles, specs, and cases`);
  }
  for (const profileName of feature.profiles ?? []) {
    const profile = knownProfiles.get(profileName);
    if (!profile) fail(`${feature.id} references unknown profile ${profileName}`);
    else if (!profile.groups.includes(feature.layer)) {
      fail(`${feature.id} claims profile ${profileName}, but that profile omits ${feature.layer}`);
    }
  }
  for (const spec of feature.specs ?? []) {
    referencedSpecs.add(spec);
    if (!/^specs\/[0-9]{2}-[a-z0-9-]+\/[a-z0-9-]+\.live\.spec\.ts$/.test(spec)) {
      fail(`${feature.id} has non-conforming live spec path ${spec}`);
    }
    if (!existsSync(join(e2eRoot, spec))) fail(`${feature.id} references missing spec ${spec}`);
    if (!spec.startsWith(`specs/${feature.layer}/`)) {
      fail(`${feature.id} spec ${spec} does not belong to layer ${feature.layer}`);
    }
  }

  const featureSurfaceSet = new Set(feature.httpSurfaces ?? []);
  for (const coverageCase of feature.cases ?? []) {
    const prefix = `${feature.id}.`;
    if (
      typeof coverageCase.caseId !== 'string' ||
      !coverageCase.caseId.startsWith(prefix) ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(coverageCase.caseId)
    ) {
      fail(`${feature.id} has invalid caseId ${String(coverageCase.caseId)}`);
      continue;
    }
    if (caseIds.has(coverageCase.caseId)) fail(`duplicate caseId ${coverageCase.caseId}`);
    else caseIds.add(coverageCase.caseId);
    caseById.set(coverageCase.caseId, coverageCase);
    featureByCaseId.set(coverageCase.caseId, feature);
    if (!['behavioral', 'fixture', 'evidence'].includes(coverageCase.kind)) {
      fail(`${coverageCase.caseId} kind must be behavioral, fixture, or evidence`);
    }
    if (!['pending', 'implemented'].includes(coverageCase.status)) {
      fail(`${coverageCase.caseId} status must be pending or implemented`);
    }
    for (const field of ['title', 'persona']) {
      if (typeof coverageCase[field] !== 'string' || coverageCase[field].length === 0) {
        fail(`${coverageCase.caseId} must declare ${field}`);
      }
    }
    for (const field of ['profiles', 'assertions', 'specTestIds', 'httpSurfaces']) {
      if (!Array.isArray(coverageCase[field]))
        fail(`${coverageCase.caseId} must declare array ${field}`);
    }
    if (!coverageCase.profiles?.length || !coverageCase.assertions?.length) {
      fail(`${coverageCase.caseId} must declare non-empty profiles and assertions`);
    }
    for (const assertion of coverageCase.assertions ?? []) {
      if (typeof assertion !== 'string' || assertion.length < 8)
        fail(`${coverageCase.caseId} has an invalid assertion`);
    }
    for (const profileName of coverageCase.profiles ?? []) {
      if (!feature.profiles?.includes(profileName)) {
        fail(`${coverageCase.caseId} profile ${profileName} is outside feature ${feature.id}`);
      }
    }
    const finalizedEvidence =
      coverageCase.kind === 'evidence' &&
      ['evidence', 'cleanup'].includes(coverageCase.evidenceSource) &&
      typeof coverageCase.evidenceProducer === 'string' &&
      coverageCase.evidenceProducer.length > 0;
    if (
      coverageCase.status === 'implemented' &&
      coverageCase.kind !== 'fixture' &&
      !finalizedEvidence &&
      coverageCase.specTestIds?.length === 0
    ) {
      fail(`${coverageCase.caseId} cannot be implemented without a live specTestId`);
    }
    if (coverageCase.evidenceSource !== undefined || coverageCase.evidenceProducer !== undefined) {
      if (!finalizedEvidence) {
        fail(`${coverageCase.caseId} finalized evidence metadata is invalid`);
      }
      if (coverageCase.specTestIds?.length) {
        fail(`${coverageCase.caseId} finalized evidence cannot declare Playwright specTestIds`);
      }
      if (coverageCase.httpSurfaces?.length) {
        fail(`${coverageCase.caseId} finalized evidence cannot claim behavioral HTTP surfaces`);
      }
    }
    if (coverageCase.kind === 'fixture') {
      if (
        typeof coverageCase.fixtureProducer !== 'string' ||
        coverageCase.fixtureProducer.length === 0
      ) {
        fail(`${coverageCase.caseId} fixture must declare fixtureProducer`);
      }
      if (coverageCase.httpSurfaces?.length) {
        fail(`${coverageCase.caseId} fixture cannot claim behavioral HTTP surfaces`);
      }
      if (coverageCase.specTestIds?.length) {
        fail(`${coverageCase.caseId} fixture cannot declare Playwright specTestIds`);
      }
    }
    for (const specTestId of coverageCase.specTestIds ?? []) {
      if (typeof specTestId !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(specTestId)) {
        fail(`${coverageCase.caseId} has invalid specTestId ${String(specTestId)}`);
      }
      const prior = declaredSpecTestIds.get(specTestId);
      if (prior && prior !== coverageCase.caseId) {
        fail(`specTestId ${specTestId} is assigned to both ${prior} and ${coverageCase.caseId}`);
      } else declaredSpecTestIds.set(specTestId, coverageCase.caseId);
    }
    for (const surface of coverageCase.httpSurfaces ?? []) {
      if (coverageCase.kind !== 'behavioral')
        fail(`${coverageCase.caseId} non-behavioral case claims ${surface}`);
      if (!featureSurfaceSet.has(surface))
        fail(`${coverageCase.caseId} claims surface outside ${feature.id}: ${surface}`);
      const prior = caseSurfaceOwners.get(surface);
      if (prior)
        fail(
          `HTTP surface ${surface} is assigned to both cases ${prior} and ${coverageCase.caseId}`,
        );
      else caseSurfaceOwners.set(surface, coverageCase.caseId);
    }
  }
}
for (const surface of httpSurfaces) {
  if (!caseSurfaceOwners.has(surface))
    fail(`exact HTTP surface has no atomic behavioral case: ${surface}`);
}
for (const surface of caseSurfaceOwners.keys()) {
  if (!httpSurfaces.includes(surface)) fail(`case owns stale HTTP surface ${surface}`);
}

const specFiles = walk(join(e2eRoot, 'specs'))
  .filter((path) => path.endsWith('.spec.ts'))
  .sort();
const markerByTestId = new Map();
const markerPattern =
  /\btest\s*\(\s*['"]([^'"]+)['"]\s*,\s*coverageCase\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,?\s*\)\s*,/g;
for (const layer of knownLayers) {
  if (
    !specFiles.some((path) => slash(relative(join(e2eRoot, 'specs'), path)).startsWith(`${layer}/`))
  ) {
    fail(`layer ${layer} has no executable spec`);
  }
}
for (const path of specFiles) {
  const spec = slash(relative(e2eRoot, path));
  const source = readFileSync(path, 'utf8');
  if (!referencedSpecs.has(spec)) fail(`spec ${spec} is absent from the coverage ledger`);
  const testDeclarations = [...source.matchAll(/\btest\s*\(\s*['"]/g)].length;
  const markers = [...source.matchAll(markerPattern)];
  if (testDeclarations === 0) fail(`spec ${spec} declares no tests`);
  if (markers.length !== testDeclarations) {
    fail(
      `spec ${spec} has ${testDeclarations} tests but ${markers.length} explicit coverageCase markers`,
    );
  }
  for (const marker of markers) {
    const [, title, caseId, specTestId] = marker;
    const logicalTitle = title.replace(/(?:\s+@[a-z0-9-]+)+$/g, '');
    if (logicalTitle !== specTestId) {
      fail(`spec ${spec} title ${title} does not match marker test id ${specTestId}`);
    }
    const coverageCase = caseById.get(caseId);
    const feature = featureByCaseId.get(caseId);
    if (!coverageCase || !feature) fail(`spec ${spec} marker references unknown case ${caseId}`);
    else {
      if (!feature.specs.includes(spec))
        fail(`${caseId} marker is in undeclared spec path ${spec}`);
      if (!coverageCase.specTestIds.includes(specTestId)) {
        fail(`${caseId} marker test id ${specTestId} is absent from the case ledger`);
      }
    }
    const prior = markerByTestId.get(specTestId);
    if (prior) fail(`specTestId ${specTestId} is marked in both ${prior.spec} and ${spec}`);
    else markerByTestId.set(specTestId, { caseId, spec, title });
  }
  if (/\b(?:test|describe)\s*\.\s*(?:skip|fixme|only)\b/.test(source))
    fail(`spec ${spec} uses skip/fixme/only`);
  if (/expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/.test(source)) {
    fail(`spec ${spec} contains a placeholder PASS assertion`);
  }
  const forbidden = [
    [/\b(?:page|context)\s*\.\s*route\s*\(/, 'network route mocking'],
    [/\broute\s*\.\s*fulfill\s*\(/, 'route fulfilment'],
    [/\bpage\s*\.\s*setContent\s*\(/, 'synthetic page content'],
    [/\b(?:vi|jest)\s*\.\s*mock\s*\(/, 'module mocking'],
    [/\btoHaveScreenshot\s*\(/, 'visual screenshot assertion'],
    [/\btoMatchSnapshot\s*\(/, 'snapshot assertion'],
    [/__screenshots__|update-snapshots|\.snap(?:\W|$)/, 'visual baseline artifact'],
  ];
  for (const [pattern, label] of forbidden)
    if (pattern.test(source)) fail(`spec ${spec} uses forbidden ${label}`);
}
for (const [specTestId, caseId] of declaredSpecTestIds) {
  const marker = markerByTestId.get(specTestId);
  if (!marker) fail(`${caseId} declares specTestId ${specTestId} but no live spec marker exists`);
  else if (marker.caseId !== caseId)
    fail(`${specTestId} marker maps ${marker.caseId}, ledger maps ${caseId}`);
}

const sourceFiles = walk(e2eRoot, new Set(['node_modules', '.runtime']));
for (const path of sourceFiles) {
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.snap'].includes(extname(path).toLowerCase())) {
    fail(`visual baseline-like artifact is forbidden: ${slash(relative(e2eRoot, path))}`);
  }
}

const playwrightConfig = readFileSync(join(e2eRoot, 'playwright.config.ts'), 'utf8');
if (/ignoreHTTPSErrors\s*:\s*true/.test(playwrightConfig))
  fail('Playwright must not disable TLS verification');
if (/['"]--ignore-certificate-errors['"]/.test(playwrightConfig)) {
  fail('Playwright must not use the broad --ignore-certificate-errors switch');
}
if (!/trace\s*:\s*['"]off['"]/.test(playwrightConfig)) {
  fail('Playwright trace must stay off because traces retain credentials and tokens');
}
if (!/video\s*:\s*['"]off['"]/.test(playwrightConfig)) {
  fail('Playwright video must stay off because recordings can retain credentials');
}

function parseEnvFile(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        return index < 1 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

function collectReportSpecs(node, output = []) {
  if (Array.isArray(node?.specs)) output.push(...node.specs);
  for (const suite of node?.suites ?? []) collectReportSpecs(suite, output);
  return output;
}

async function validateRequiredProfileEvidence(profileName) {
  if (!knownProfiles.has(profileName)) {
    fail(`unknown required profile ${profileName}`);
    return;
  }
  const requiredCases = [...caseById.values()].filter((coverageCase) =>
    coverageCase.profiles.includes(profileName),
  );
  for (const coverageCase of requiredCases) {
    if (coverageCase.status !== 'implemented') {
      fail(
        `${profileName} coverage is incomplete: ${coverageCase.caseId} is ${coverageCase.status}`,
      );
    }
  }

  const runId = process.env.E2E_RUN_ID;
  const runtimeRootValue = process.env.E2E_RUNTIME_ROOT;
  if (!runId || !runtimeRootValue) {
    fail(
      `${profileName} closure requires E2E_RUN_ID and E2E_RUNTIME_ROOT from the current orchestrated run`,
    );
    fail(
      'post-down coverage evidence is not wired into the orchestrator yet; --require-profile fails closed',
    );
    return;
  }
  const runtimeRoot = resolve(runtimeRootValue);
  const selectedEvidenceValue =
    evidenceValue ??
    process.env.E2E_COVERAGE_EVIDENCE ??
    join(runtimeRoot, 'coverage-evidence.json');
  const evidencePath = isAbsolute(selectedEvidenceValue)
    ? resolve(selectedEvidenceValue)
    : resolve(runtimeRoot, selectedEvidenceValue);
  const withinRuntime = (path) => path === runtimeRoot || path.startsWith(`${runtimeRoot}${sep}`);
  const artifactPath = (value, label) => {
    if (typeof value !== 'string' || value.length === 0) {
      fail(`${label} must be a non-empty path`);
      return null;
    }
    const path = isAbsolute(value) ? resolve(value) : resolve(runtimeRoot, value);
    if (!withinRuntime(path)) fail(`${label} escapes E2E_RUNTIME_ROOT: ${value}`);
    if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
    return existsSync(path) ? path : null;
  };
  if (!withinRuntime(evidencePath))
    fail(`coverage evidence escapes E2E_RUNTIME_ROOT: ${evidencePath}`);
  if (!existsSync(evidencePath)) {
    fail(`${profileName} closure requires current-run evidence file ${evidencePath}`);
    fail(
      'post-down coverage evidence is not wired into the orchestrator yet; --require-profile fails closed',
    );
    return;
  }
  const evidenceInfo = lstatSync(evidencePath);
  if (!evidenceInfo.isFile() || evidenceInfo.isSymbolicLink())
    fail(`coverage evidence must be a regular file: ${evidencePath}`);
  if ((evidenceInfo.mode & 0o077) !== 0)
    fail(`coverage evidence must be mode 0600: ${evidencePath}`);

  let evidence;
  try {
    evidence = readJson(evidencePath, 'coverage evidence');
  } catch (error) {
    fail(error.message);
    return;
  }
  if (evidence.schemaVersion !== 1) fail('coverage evidence schemaVersion must be 1');
  if (evidence.runId !== runId)
    fail(`coverage evidence runId ${evidence.runId} does not match ${runId}`);
  if (evidence.profile !== profileName)
    fail(`coverage evidence profile ${evidence.profile} does not match ${profileName}`);
  if (!validDate(evidence.generatedAt))
    fail('coverage evidence generatedAt must be an ISO date-time');
  if (evidence.ledgerSha256 !== sha256File(ledgerPath))
    fail('coverage evidence ledgerSha256 is not current');

  const buildPath = artifactPath(evidence.build?.provenancePath, 'build.provenancePath');
  let buildEnv = {};
  if (buildPath) {
    if (evidence.build?.provenanceSha256 !== sha256File(buildPath))
      fail('build provenanceSha256 mismatch');
    buildEnv = parseEnvFile(buildPath);
    const buildFields = {
      BUILD_SCHEMA_VERSION: '1',
      GIT_SHA: evidence.build?.gitSha,
      TRACKED_DIFF_SHA256: evidence.build?.trackedDiffSha256,
      UNTRACKED_SOURCE_SHA256: evidence.build?.untrackedSourceSha256,
      PRODUCT_SOURCE_SHA256: evidence.build?.productSourceSha256,
      BACKEND_IMAGE_ID: evidence.build?.backendImageId,
      NODE_IMAGE_ID: evidence.build?.nodeImageId,
      BUILT_AT: evidence.build?.builtAt,
    };
    for (const [name, expected] of Object.entries(buildFields)) {
      if (buildEnv[name] !== expected)
        fail(`build evidence ${name} does not match provenance file`);
    }
    const currentGitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    if (buildEnv.GIT_SHA !== currentGitSha)
      fail(`build provenance is not current HEAD ${currentGitSha}`);
    // Consume the exact bytes used by orchestrator/build.sh. This includes the
    // retired root test tree's tracked deletion/absence and .gitignore bytes.
    const provenancePathspec = readFileSync(
      join(e2eRoot, 'orchestrator', 'release-source-pathspec.txt'),
      'utf8',
    ).split('\n').filter(Boolean);
    const trackedDiffSha256 = await sha256Command(
      'git',
      ['diff', '--binary', 'HEAD', '--', ...provenancePathspec],
      { cwd: repoRoot },
    );
    if (buildEnv.TRACKED_DIFF_SHA256 !== trackedDiffSha256) {
      fail('build provenance tracked diff is stale for the current worktree');
    }
    const untracked = execFileSync(
      'git',
      ['ls-files', '-z', '--others', '--exclude-standard', '--', ...provenancePathspec],
      { cwd: repoRoot },
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .sort();
    const untrackedLines = untracked
      .map((file) => {
        const absolute = join(repoRoot, file);
        return `${sha256File(absolute)}  ${absolute}\n`;
      })
      .join('');
    if (buildEnv.UNTRACKED_SOURCE_SHA256 !== sha256Buffer(untrackedLines)) {
      fail('build provenance untracked-source digest is stale for the current worktree');
    }
  }

  const reportPath = artifactPath(evidence.playwright?.reportPath, 'playwright.reportPath');
  let report = null;
  const passedMarkers = new Set();
  if (reportPath) {
    if (evidence.playwright?.reportSha256 !== sha256File(reportPath))
      fail('Playwright reportSha256 mismatch');
    report = readJson(reportPath, 'Playwright JSON report');
    if (evidence.playwright?.status !== 'passed') fail('Playwright evidence status must be passed');
    if (report.config?.metadata?.runId !== runId)
      fail('Playwright report runId does not match current run');
    if (report.config?.metadata?.profile !== profileName)
      fail('Playwright report profile does not match required profile');
    if (report.config?.metadata?.cpuOnly !== true) fail('Playwright report is not CPU-only');
    if (!validDate(evidence.playwright?.startedAt) || !validDate(evidence.playwright?.finishedAt)) {
      fail('Playwright startedAt and finishedAt must be ISO date-times');
    }
    if (report.stats?.startTime !== evidence.playwright?.startedAt)
      fail('Playwright startedAt does not match JSON report');
    const calculatedFinish =
      Date.parse(report.stats?.startTime) + Number(report.stats?.duration ?? Number.NaN);
    if (Math.abs(calculatedFinish - Date.parse(evidence.playwright?.finishedAt)) > 2000) {
      fail('Playwright finishedAt does not match JSON report duration');
    }
    if (
      report.stats?.unexpected !== 0 ||
      report.stats?.flaky !== 0 ||
      report.stats?.skipped !== 0 ||
      !Array.isArray(report.errors) ||
      report.errors.length !== 0 ||
      !(report.stats?.expected > 0)
    ) {
      fail(
        'Playwright report is not an all-tests PASS (expected>0, skipped=unexpected=flaky=errors=0 required)',
      );
    }
    for (const spec of collectReportSpecs(report)) {
      const specPath = `specs/${slash(spec.file ?? '')}`;
      for (const reportTest of spec.tests ?? []) {
        const annotations = reportTest.annotations ?? [];
        const caseAnnotation = annotations.find(
          (entry) => entry.type === 'nyabase.coverage.case',
        )?.description;
        const testIdAnnotation = annotations.find(
          (entry) => entry.type === 'nyabase.coverage.test-id',
        )?.description;
        const passed =
          reportTest.status === 'expected' &&
          (reportTest.results ?? []).some((result) => result.status === 'passed');
        if (!caseAnnotation || !testIdAnnotation)
          fail(`Playwright test ${spec.title} lacks coverage annotations`);
        else if (passed) passedMarkers.add(`${caseAnnotation}|${testIdAnnotation}|${specPath}`);
        else fail(`Playwright marker ${caseAnnotation}|${testIdAnnotation} did not pass`);
      }
    }
  }

  if (!Array.isArray(evidence.caseEvents)) fail('coverage evidence caseEvents must be an array');
  const eventKeys = new Set();
  const eventsByCase = new Map();
  for (const event of evidence.caseEvents ?? []) {
    const coverageCase = caseById.get(event.caseId);
    const feature = featureByCaseId.get(event.caseId);
    if (!coverageCase || !feature) {
      fail(`case event references unknown case ${String(event.caseId)}`);
      continue;
    }
    if (!coverageCase.profiles.includes(profileName))
      fail(`case event ${event.caseId} is outside profile ${profileName}`);
    if (event.kind !== coverageCase.kind)
      fail(`case event ${event.caseId} kind does not match ledger`);
    if (event.status !== 'passed') fail(`case event ${event.caseId} must have passed status`);
    if (!validDate(event.observedAt))
      fail(`case event ${event.caseId} observedAt must be an ISO date-time`);
    if (!Array.isArray(event.observedHttpSurfaces))
      fail(`case event ${event.caseId} must list observedHttpSurfaces`);
    const expectedSurfaces = [...coverageCase.httpSurfaces].sort();
    const observedSurfaces = [...(event.observedHttpSurfaces ?? [])].sort();
    if (JSON.stringify(expectedSurfaces) !== JSON.stringify(observedSurfaces)) {
      fail(`case event ${event.caseId} does not exactly attest its declared HTTP surfaces`);
    }
    const key = `${event.caseId}|${event.specTestId ?? event.fixtureProducer ?? event.evidenceProducer ?? ''}`;
    if (eventKeys.has(key)) fail(`duplicate case event ${key}`);
    else eventKeys.add(key);
    const caseEvents = eventsByCase.get(event.caseId) ?? [];
    caseEvents.push(event);
    eventsByCase.set(event.caseId, caseEvents);
    const finalizedEvidence =
      coverageCase.kind === 'evidence' &&
      ['evidence', 'cleanup'].includes(coverageCase.evidenceSource) &&
      typeof coverageCase.evidenceProducer === 'string';
    if (coverageCase.kind === 'fixture') {
      if (event.source !== 'fixture')
        fail(`fixture ${event.caseId} cannot count a Playwright request as setup proof`);
      if (event.fixtureProducer !== coverageCase.fixtureProducer)
        fail(`fixture ${event.caseId} producer mismatch`);
      const artifact = artifactPath(event.artifactPath, `fixture ${event.caseId} artifactPath`);
      if (artifact) {
        const info = lstatSync(artifact);
        if (!info.isFile() || info.isSymbolicLink())
          fail(`fixture ${event.caseId} artifact must be a regular file`);
        if ((info.mode & 0o777) !== 0o600)
          fail(`fixture ${event.caseId} artifact must be mode 0600`);
        if (!withinRuntime(realpathSync(artifact)))
          fail(`fixture ${event.caseId} artifact resolves outside E2E_RUNTIME_ROOT`);
        if (event.artifactSha256 !== sha256File(artifact))
          fail(`fixture ${event.caseId} artifactSha256 mismatch`);
        const proof = readJson(artifact, `fixture ${event.caseId} proof`);
        if (
          proof.schemaVersion !== 1 ||
          proof.runId !== runId ||
          proof.caseId !== event.caseId ||
          proof.producer !== coverageCase.fixtureProducer ||
          proof.status !== 'passed' ||
          proof.observedAt !== event.observedAt ||
          !proof.claims ||
          typeof proof.claims !== 'object' ||
          Array.isArray(proof.claims)
        ) {
          fail(`fixture ${event.caseId} proof binding mismatch`);
        }
      }
      if (event.specTestId || event.specPath)
        fail(`fixture ${event.caseId} event cannot masquerade as behavioral spec evidence`);
    } else if (finalizedEvidence) {
      if (event.source !== coverageCase.evidenceSource) {
        fail(`${event.caseId} must use ${coverageCase.evidenceSource} evidence`);
      }
      if (event.evidenceProducer !== coverageCase.evidenceProducer) {
        fail(`${event.caseId} finalized evidence producer mismatch`);
      }
      if (event.specTestId || event.specPath || event.fixtureProducer) {
        fail(`${event.caseId} finalized evidence cannot masquerade as Playwright or fixture proof`);
      }
      const artifact = artifactPath(event.artifactPath, `${event.caseId} artifactPath`);
      if (artifact) {
        const info = lstatSync(artifact);
        if (!info.isFile() || info.isSymbolicLink()) {
          fail(`${event.caseId} finalized evidence artifact must be a regular file`);
        }
        if ((info.mode & 0o077) !== 0) {
          fail(`${event.caseId} finalized evidence artifact must be mode 0600`);
        }
        if (!withinRuntime(realpathSync(artifact))) {
          fail(`${event.caseId} finalized evidence artifact resolves outside E2E_RUNTIME_ROOT`);
        }
        if (event.artifactSha256 !== sha256File(artifact)) {
          fail(`${event.caseId} finalized evidence artifactSha256 mismatch`);
        }
        if (coverageCase.evidenceSource === 'evidence') {
          if (artifact !== buildPath || event.artifactSha256 !== evidence.build?.provenanceSha256) {
            fail(`${event.caseId} is not bound to current build provenance`);
          }
        } else {
          const proof = readJson(artifact, `${event.caseId} finalized evidence artifact`);
          if (
            [
              'cleanup.release-evidence.public-api-cleanup',
              'cleanup.release-evidence.inner-docker-cleanup',
            ].includes(event.caseId)
          ) {
            if (
              proof.schemaVersion !== 1 ||
              proof.runId !== runId ||
              proof.productLifecycle?.controlPlaneAbsent !== true ||
              !Array.isArray(proof.physical?.nodes) ||
              proof.physical.nodes.length !== 2 ||
              !proof.physical.nodes.every(
                (node) => node.managedContainerCount === 0 && node.deletedRuntimeAbsent === true,
              )
            ) {
              fail(`${event.caseId} lifecycle cleanup probe is incomplete`);
            }
          } else if (event.caseId === fullChainCaseId) {
            try {
              validateFullRunChainArtifact({
                runtimeDir: runtimeRoot,
                runId,
                evidence,
                event,
              });
            } catch (error) {
              fail(`${event.caseId} proof is invalid: ${error.message}`);
            }
          } else if (event.caseId === 'cleanup.release-evidence.redacted-provenance') {
            if (proof.schemaVersion !== 1 || proof.runId !== runId || proof.status !== 'clean') {
              fail(`${event.caseId} artifact credential audit is not clean`);
            }
          } else {
            try {
              assertCleanManifest(proof, runId, `${event.caseId} cleaned manifest proof`);
            } catch {
              fail(`${event.caseId} cleaned manifest proof is incomplete`);
            }
          }
        }
      }
    } else {
      if (event.source !== 'playwright') fail(`${event.caseId} must use Playwright evidence`);
      if (!coverageCase.specTestIds.includes(event.specTestId))
        fail(`${event.caseId} event has undeclared specTestId`);
      if (!feature.specs.includes(event.specPath))
        fail(`${event.caseId} event has undeclared specPath`);
      if (!passedMarkers.has(`${event.caseId}|${event.specTestId}|${event.specPath}`)) {
        fail(`${event.caseId} event has no matching passed Playwright marker at ${event.specPath}`);
      }
    }
  }
  for (const coverageCase of requiredCases) {
    const events = eventsByCase.get(coverageCase.caseId) ?? [];
    if (coverageCase.kind === 'fixture') {
      if (events.length !== 1) fail(`${coverageCase.caseId} requires exactly one fixture event`);
    } else if (
      coverageCase.kind === 'evidence' &&
      ['evidence', 'cleanup'].includes(coverageCase.evidenceSource)
    ) {
      if (
        fullChainCandidate &&
        coverageCase.caseId === fullChainCaseId &&
        events.length === 0
      ) {
        continue;
      }
      if (
        events.length !== 1 ||
        events[0].source !== coverageCase.evidenceSource ||
        events[0].evidenceProducer !== coverageCase.evidenceProducer
      ) {
        fail(`${coverageCase.caseId} requires exactly one finalized evidence event`);
      }
    } else {
      for (const specTestId of coverageCase.specTestIds) {
        if (!events.some((event) => event.specTestId === specTestId)) {
          fail(`${coverageCase.caseId} lacks current-run case event for ${specTestId}`);
        }
      }
    }
  }

  const manifestPath = artifactPath(evidence.cleanup?.manifestPath, 'cleanup.manifestPath');
  if (evidence.cleanup?.phase !== 'post-down' || evidence.cleanup?.status !== 'clean') {
    fail('coverage closure requires cleanup phase=post-down and status=clean');
  }
  if (evidence.cleanup?.manifestSchemaVersion !== manifestSchemaVersion) {
    fail('coverage closure does not bind the current manifest schema');
  }
  if (!validDate(evidence.cleanup?.checkedAt)) fail('cleanup.checkedAt must be an ISO date-time');
  if (manifestPath) {
    if (evidence.cleanup?.manifestSha256 !== sha256File(manifestPath))
      fail('cleanup manifestSha256 mismatch');
    const manifest = readJson(manifestPath, 'cleanup manifest');
    try {
      assertCleanManifest(manifest, runId, 'cleanup manifest');
    } catch {
      fail('cleanup manifest does not prove current-run clean teardown');
    }
    if (manifest.cleanup?.checkedAt !== evidence.cleanup?.checkedAt)
      fail('cleanup checkedAt does not match manifest');
  }
  const builtAt = Date.parse(evidence.build?.builtAt);
  const startedAt = Date.parse(evidence.playwright?.startedAt);
  const finishedAt = Date.parse(evidence.playwright?.finishedAt);
  const cleanedAt = Date.parse(evidence.cleanup?.checkedAt);
  const generatedAt = Date.parse(evidence.generatedAt);
  if (
    ![builtAt, startedAt, finishedAt, cleanedAt, generatedAt].every(Number.isFinite) ||
    !(
      builtAt <= startedAt &&
      startedAt <= finishedAt &&
      finishedAt <= cleanedAt &&
      cleanedAt <= generatedAt
    )
  ) {
    fail(
      'evidence phases must be ordered build <= Playwright <= post-down cleanup <= evidence generation',
    );
  }
  for (const event of evidence.caseEvents ?? []) {
    const observedAt = Date.parse(event.observedAt);
    const latest = event.source === 'cleanup' ? generatedAt + 5000 : finishedAt + 5000;
    if (!Number.isFinite(observedAt) || observedAt < builtAt - 5000 || observedAt > latest) {
      fail(`case event ${event.caseId} is outside its current-run evidence window`);
    }
    if (event.source === 'cleanup' && observedAt < finishedAt) {
      fail(`cleanup case event ${event.caseId} precedes Playwright completion`);
    }
  }
}

if (requiredProfile) await validateRequiredProfileEvidence(requiredProfile);

if (failures.length > 0) {
  console.error('CPU E2E coverage validation FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const cases = [...caseById.values()];
  const pending = cases.filter((coverageCase) => coverageCase.status === 'pending').length;
  const implemented = cases.length - pending;
  const behavioral = cases.filter((coverageCase) => coverageCase.kind === 'behavioral').length;
  const fixtures = cases.filter((coverageCase) => coverageCase.kind === 'fixture').length;
  console.log('CPU E2E framework contract validation PASS');
  console.log(
    `- exact HTTP surfaces: ${httpSurfaces.length} across ${controllerFiles.length} controllers`,
  );
  console.log(`- exact HTTP inventory sha256: ${httpInventorySha256}`);
  console.log(`- frontend routes: ${routeFiles.length}`);
  console.log(`- AgentTaskKind values: ${agentTaskKinds.length}`);
  console.log(`- WebSocket paths: ${websocketPaths.length}`);
  console.log(
    `- cases: ${cases.length} (${implemented} implemented, ${pending} pending; ${behavioral} behavioral, ${fixtures} fixture)`,
  );
  console.log(
    `- behavioral coverage closure: ${behavioralClosureLabel({
      requiredProfile,
      fullChainCandidate,
      pending,
    })}`,
  );
  console.log(`- executable marked live tests: ${markerByTestId.size}`);
}
