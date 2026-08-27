#!/usr/bin/env node
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(e2eRoot, '..');
const ledgerPath = join(e2eRoot, 'coverage', 'features.yaml');
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const errors = [];
const warnings = [];

const requiredProfile = process.argv.find((value) => value.startsWith('--require-profile='))
  ?.split('=', 2)[1];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function normalizePath(value) {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

function joinRoutes(controller, method) {
  const left = normalizePath(controller);
  const right = normalizePath(method);
  return `${left}${right}` || '/';
}

function parseHttpRoutes() {
  const declarations = [];
  const files = walk(join(repoRoot, 'packages', 'backend', 'src'))
    .filter((path) => path.endsWith('.controller.ts'));
  for (const file of files) {
    let controller = '';
    let lineNumber = 0;
    for (const line of readText(file).split(/\r?\n/)) {
      lineNumber += 1;
      const controllerMatch = line.match(/@Controller(?:\(\s*(['"])(.*?)\1\s*\))?/);
      if (controllerMatch) {
        controller = controllerMatch[2] ?? '';
        continue;
      }
      const methodMatch = line.match(
        /@(Get|Post|Put|Patch|Delete|All)(?:\(\s*(['"])(.*?)\2\s*\))?/,
      );
      if (!methodMatch || controller === undefined) continue;
      const method = methodMatch[1].toUpperCase();
      const route = joinRoutes(controller, methodMatch[3] ?? '');
      declarations.push({
        file: relative(repoRoot, file).replaceAll('\\', '/'),
        lineNumber,
        method,
        route,
        surface: `${method}|/api${route === '/' ? '' : route}`,
      });
    }
  }
  return declarations;
}

function isRetiredRoute(surface) {
  const lower = surface.toLowerCase();
  const retiredMarkers = [
    ['a', 'gent'].join(''),
    ['remote', '-', 'fs'].join(''),
    ['data', '-', 'dir'].join(''),
    ['mount', '-', 'source'].join(''),
  ];
  return /\/v\d+(?:\/|$)/.test(lower)
    || retiredMarkers.some((marker) => lower.includes(marker));
}

function parseIntentKinds() {
  const source = readText(join(repoRoot, 'packages', 'common', 'src', 'enums.ts'));
  const block = source.match(/enum\s+IntentKind\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  return [...block.matchAll(/=\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function parseWebsocketPaths() {
  const source = readText(join(repoRoot, 'packages', 'backend', 'src', 'main.ts'));
  return [...source.matchAll(/['"](\/ws\/[^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((path, index, values) => values.indexOf(path) === index)
    .sort();
}

function parseFrontendRoutes() {
  const files = walk(join(repoRoot, 'packages', 'frontend', 'src', 'routes'))
    .filter((path) => path.endsWith('.tsx'));
  return [...new Set(files.flatMap((file) => (
    [...readText(file).matchAll(/createFileRoute\(\s*(['"])(.*?)\1\s*\)/g)]
      .map((match) => match[2])
  )))].sort();
}

function allCases() {
  return ledger.features.flatMap((feature) => feature.cases ?? []);
}

function caseMap() {
  return new Map(allCases().map((entry) => [entry.caseId, entry]));
}

function markerInventory() {
  const markers = [];
  for (const file of walk(join(e2eRoot, 'specs')).filter((path) => path.endsWith('.spec.ts'))) {
    const source = readText(file);
    for (const match of source.matchAll(
      /coverageCase\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g,
    )) {
      markers.push({
        caseId: match[1],
        specTestId: match[2],
        file: relative(repoRoot, file).replaceAll('\\', '/'),
      });
    }
  }
  return markers;
}

function validateLedger(
  httpDeclarations,
  canonicalRoutes,
  intentKinds,
  websocketPaths,
  frontendRoutes,
) {
  assert(ledger.schemaVersion === 3, 'coverage ledger schemaVersion must be 3');
  assert(ledger.architecture?.runtime === 'incus', 'ledger must declare the Incus runtime');
  assert(ledger.architecture?.httpPrefix === '/api', 'ledger must declare the /api prefix');
  assert(
    ledger.architecture?.routeSource === 'packages/backend/src/**/*.controller.ts',
    'ledger route source must be the backend controller tree',
  );
  assert(
    ledger.architecture?.intentSource === 'packages/common/src/enums.ts',
    'ledger intent source must be the common enum source',
  );
  assert(
    ledger.topology?.provider === 'incus-standalone',
    'ledger topology must be incus-standalone',
  );
  assert(
    ledger.topology?.storageFamilies?.some((entry) => (
      entry.driver === 'dir' && entry.resizeFamily === 'quota_online'
    )),
    'ledger must declare the dir quota_online storage family',
  );
  assert(
    ledger.topology?.storageFamilies?.some((entry) => (
      entry.driver === 'lvm' && entry.resizeFamily === 'block_backed'
    )),
    'ledger must declare the lvm block_backed storage family',
  );
  assert(
    ledger.topology.blocked?.some((entry) => entry.capability === 'gpu-pci'
      && entry.status === 'BLOCKED'),
    'GPU coverage must be explicitly BLOCKED',
  );
  assert(
    ledger.topology.blocked?.some((entry) => entry.capability === 'cephfs-cluster'
      && entry.status === 'BLOCKED'),
    'CephFS coverage must be explicitly BLOCKED',
  );

  const actualSurfaces = new Set(canonicalRoutes.map((entry) => entry.surface));
  const listedSurfaces = new Set(
    ledger.features.flatMap((feature) => feature.cases ?? [])
      .flatMap((entry) => entry.httpSurfaces ?? []),
  );
  const listedSurfaceValues = ledger.features.flatMap((feature) => feature.cases ?? [])
    .flatMap((entry) => entry.httpSurfaces ?? []);
  assert(
    listedSurfaceValues.length === listedSurfaces.size,
    'coverage ledger assigns one HTTP surface to multiple cases',
  );
  for (const surface of listedSurfaces) {
    assert(actualSurfaces.has(surface), `listed HTTP surface is not canonical: ${surface}`);
  }
  for (const surface of actualSurfaces) {
    const owners = (ledger.routeOwners ?? []).filter((owner) => (
      surface.split('|')[1].startsWith(owner.prefix)
    ));
    assert(owners.length === 1, `canonical HTTP surface has ${owners.length} owners: ${surface}`);
    assert(caseMap().has(owners[0]?.caseId), `route owner case is unknown: ${surface}`);
  }

  const expectedWebsockets = [...new Set(ledger.websocketPaths ?? [])].sort();
  assert(
    JSON.stringify(expectedWebsockets) === JSON.stringify(websocketPaths),
    `WebSocket inventory drifted: expected ${websocketPaths.join(',')}, ledger ${expectedWebsockets.join(',')}`,
  );
  assert(
    JSON.stringify([...ledger.frontendRoutes].sort()) === JSON.stringify(frontendRoutes),
    `frontend route inventory drifted: expected ${frontendRoutes.join(',')}, ledger ${
      [...ledger.frontendRoutes].sort().join(',')
    }`,
  );
  assert(
    JSON.stringify([...ledger.intentKinds].sort()) === JSON.stringify([...intentKinds].sort()),
    'IntentKind inventory drifted from packages/common/src/enums.ts',
  );

  const inventory = ledger.inventory;
  if (inventory) {
    assert(inventory.controllerFileCount === new Set(canonicalRoutes.map((entry) => entry.file)).size,
      'controller file inventory drifted');
    assert(inventory.httpDecoratorCount === httpDeclarations.length,
      'HTTP decorator inventory drifted');
    assert(inventory.httpSurfaceCount === actualSurfaces.size,
      'HTTP surface inventory drifted');
    assert(inventory.intentKindCount === intentKinds.length,
      'IntentKind count drifted');
    assert(inventory.websocketPathCount === websocketPaths.length,
      'WebSocket path count drifted');
  } else {
    warn('ledger.inventory is absent; run the validator once after route changes to freeze counts');
  }
}

function validateCases() {
  const cases = allCases();
  const ids = new Set();
  for (const entry of cases) {
    assert(!ids.has(entry.caseId), `duplicate coverage case ${entry.caseId}`);
    ids.add(entry.caseId);
    assert(['implemented', 'blocked'].includes(entry.status),
      `invalid status for ${entry.caseId}`);
    assert(Array.isArray(entry.profiles) && entry.profiles.length > 0,
      `case ${entry.caseId} must name at least one profile`);
    assert(Array.isArray(entry.httpSurfaces),
      `case ${entry.caseId} must declare httpSurfaces`);
    for (const profile of entry.profiles) {
      assert(['smoke', 'core', 'full', 'recovery'].includes(profile),
        `case ${entry.caseId} names unknown profile ${profile}`);
    }
  }

  const markers = markerInventory();
  const markersByCase = new Map();
  for (const marker of markers) {
    if (!caseMap().has(marker.caseId)) {
      fail(`marker references unknown case ${marker.caseId} in ${marker.file}`);
      continue;
    }
    const list = markersByCase.get(marker.caseId) ?? [];
    list.push(marker);
    markersByCase.set(marker.caseId, list);
  }
  for (const entry of cases) {
    const markersForCase = markersByCase.get(entry.caseId) ?? [];
    if (entry.status === 'implemented') {
      assert(markersForCase.length > 0, `implemented case has no marker: ${entry.caseId}`);
    } else {
      assert(markersForCase.length === 0, `blocked case has a live marker: ${entry.caseId}`);
    }
  }

  for (const file of walk(join(e2eRoot, 'specs')).filter((path) => path.endsWith('.spec.ts'))) {
    const source = readText(file);
    assert(!/\.(skip|fixme|only)\s*\(/.test(source), `forbidden test modifier in ${file}`);
    assert(!/page\.(route|screenshot|video)|snapshot\(/.test(source),
      `mocking or snapshot evidence in ${file}`);
  }
}

function validateProfiles() {
  for (const profileName of ['smoke', 'core', 'full', 'recovery']) {
    const path = join(e2eRoot, 'profiles', `${profileName}.yaml`);
    assert(existsSync(path), `profile file missing: ${profileName}`);
    if (!existsSync(path)) continue;
    const profile = JSON.parse(readText(path));
    assert(profile.name === profileName, `profile name mismatch: ${profileName}`);
    assert(profile.runtime === 'incus', `profile ${profileName} must use Incus`);
    assert(Array.isArray(profile.groups) && profile.groups.length > 0,
      `profile ${profileName} has no spec groups`);
    assert(Array.isArray(profile.requiredCapabilities)
      && profile.requiredCapabilities.length > 0,
    `profile ${profileName} has no required capabilities`);
    for (const group of profile.groups) {
      assert(
        walk(join(e2eRoot, 'specs', group)).some((file) => file.endsWith('.spec.ts')),
        `profile ${profileName} group has no specs: ${group}`,
      );
    }
    for (const capability of profile.requiredCapabilities) {
      assert(
        topologyCapabilityNames.has(capability),
        `profile ${profileName} names unknown capability ${capability}`,
      );
    }
    const profileCases = allCases().filter((entry) => entry.profiles.includes(profileName));
    assert(profileCases.length > 0, `profile ${profileName} owns no cases`);
  }
  if (requiredProfile) {
    assert(['smoke', 'core', 'full', 'recovery'].includes(requiredProfile),
      `unknown required profile ${requiredProfile}`);
  }
}

const topologyCapabilityNames = new Set([
  'postgresql',
  'incus-https-mtls',
  'trust-token-onboarding',
  'certificate-rotation',
  'storage-dir-quota-online',
  'storage-lvm-block-backed',
  'macvlan-parent',
  'rp-filter',
  'fib-anti-spoof',
  'private-simplestreams',
  'sshd-no-dhcp-image',
  'node-exporter-authenticated-pull',
  'intent-reconciliation',
  'exec-bridge',
  'ssh-reachability',
]);

function validateForbiddenTerms() {
  const oldFragments = [
    ['/', 'api', '/', 'v', '\\d+'].join(''),
    ['task', 'Id'].join(''),
    ['a', 'gent'].join(''),
    ['dock', 'er'].join(''),
    ['remote', '-', 'fs'].join(''),
    ['data', '-', 'dir'].join(''),
  ];
  const matcher = new RegExp(oldFragments.join('|'), 'i');
  const files = [
    ...walk(join(e2eRoot, 'specs')),
    ...walk(join(e2eRoot, 'fixtures')),
    ...walk(join(e2eRoot, 'support')),
    ...walk(join(e2eRoot, 'topology')),
    ...walk(join(e2eRoot, 'orchestrator')),
    ...walk(join(e2eRoot, 'profiles')),
    ledgerPath,
  ];
  for (const file of files) {
    if (matcher.test(readText(file))) {
      fail(`retired architecture term found in ${relative(repoRoot, file)}`);
    }
  }
}

const declarations = parseHttpRoutes();
const canonicalDeclarations = declarations.filter((entry) => !isRetiredRoute(entry.surface));
const canonicalSurfaces = new Set(canonicalDeclarations.map((entry) => entry.surface));
const intentKinds = parseIntentKinds();
const websocketPaths = parseWebsocketPaths();
const frontendRoutes = parseFrontendRoutes();

validateLedger(
  declarations,
  canonicalDeclarations,
  intentKinds,
  websocketPaths,
  frontendRoutes,
);
validateCases();
validateProfiles();
validateForbiddenTerms();

if (warnings.length > 0) {
  for (const warning of warnings) console.warn(`E2E warning: ${warning}`);
}
if (errors.length > 0) {
  console.error(`E2E validation failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `E2E validation passed: ${canonicalSurfaces.size} canonical HTTP surfaces, `
  + `${declarations.length} HTTP decorators, ${new Set(canonicalDeclarations.map((entry) => entry.file)).size} controller files, `
  + `${intentKinds.length} intent kinds, ${websocketPaths.length} WebSocket paths, `
  + `${allCases().length} coverage cases`,
);
