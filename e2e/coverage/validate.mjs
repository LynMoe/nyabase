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
const ledgerPath = join(e2eRoot, 'coverage', 'features.json');
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const errors = [];
const warnings = [];

const requiredProfile = process.argv.find((value) => value.startsWith('--require-profile='))
  ?.split('=', 2)[1];
const maxUnmappedArg = process.argv.find((value) => value.startsWith('--max-unmapped='))
  ?.split('=', 2)[1];

const ALLOWED_KINDS = new Set(['behavioral', 'ws-behavioral', 'static-contract']);
const ALLOWED_STATUSES = new Set(['implemented', 'blocked']);
const ALLOWED_PROFILES = new Set(['smoke', 'core', 'full']);
const ALLOWED_PERSONAS = new Set([
  'anonymous',
  'maintainer',
  'administrator',
  'normal-user',
  'quota-limited',
  'grant-expired',
  'attacker',
]);

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



function allCases() {
  return ledger.features.flatMap((feature) => feature.cases ?? []);
}

function caseMap() {
  return new Map(allCases().map((entry) => [entry.caseId, entry]));
}

function canonicalizeSurface(surface) {
  return ledger.surfaceAliases?.[surface] ?? surface;
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
        group: groupFromSpecFile(file),
      });
    }
  }
  return markers;
}

function groupFromSpecFile(file) {
  const rel = relative(join(e2eRoot, 'specs'), file).replaceAll('\\', '/');
  const group = rel.split('/')[0];
  return group || undefined;
}

function parseMaxUnmapped() {
  const fromCli = maxUnmappedArg === undefined ? undefined : Number(maxUnmappedArg);
  const fromLedger = ledger.inventory?.maxUnmapped;
  if (fromCli !== undefined) {
    assert(Number.isInteger(fromCli) && fromCli >= 0, '--max-unmapped must be a non-negative integer');
    return fromCli;
  }
  assert(
    Number.isInteger(fromLedger) && fromLedger >= 0,
    'inventory.maxUnmapped must pin a non-negative integer unmapped budget',
  );
  return fromLedger;
}

function validateLedger(
  httpDeclarations,
  decoratorSurfaces,
  canonicalSurfaces,
  intentKinds,
  websocketPaths,
) {
  assert(ledger.schemaVersion === 4, 'coverage ledger schemaVersion must be 4');
  assert(!existsSync(join(e2eRoot, 'coverage', 'features.yaml')),
    'retired coverage/features.yaml must be removed');
  assert(ledger.routeOwners === undefined, 'schema v4 forbids blanket routeOwners');
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
  const gpuBlocked = ledger.topology.blocked?.some((entry) => (
    entry.capability === 'gpu-pci' && entry.status === 'BLOCKED'
  ));
  const gpuClaim = allCases().find((entry) => entry.caseId === 'container-gpu-pci-claim');
  assert(gpuClaim, 'container-gpu-pci-claim case is required');
  if (gpuBlocked) {
    assert(gpuClaim.status === 'blocked', 'blocked GPU must keep container-gpu-pci-claim blocked');
  } else {
    assert(
      gpuClaim.status === 'implemented',
      'an available GPU lab must implement container-gpu-pci-claim',
    );
  }
  const cephBlocked = ledger.topology.blocked?.some((entry) => (
    entry.capability === 'cephfs-cluster' && entry.status === 'BLOCKED'
  ));
  const sharedCeph = allCases().find((entry) => entry.caseId === 'shared-cephfs-storage');
  assert(sharedCeph, 'shared-cephfs-storage case is required');
  if (cephBlocked) {
    assert(sharedCeph.status === 'blocked', 'blocked CephFS must keep shared-cephfs-storage blocked');
  } else {
    assert(
      sharedCeph.status === 'implemented',
      'an available CephFS lab must implement shared-cephfs-storage',
    );
  }

  const aliases = ledger.surfaceAliases ?? {};
  const aliasEntries = Object.entries(aliases);
  assert(aliasEntries.length === 2, 'surfaceAliases must declare the two :imageId decorator collisions');
  for (const [source, target] of aliasEntries) {
    assert(decoratorSurfaces.has(source), `surface alias source is not a decorator: ${source}`);
    assert(decoratorSurfaces.has(target), `surface alias target is not a decorator: ${target}`);
    assert(canonicalSurfaces.has(target), `surface alias target is not canonical: ${target}`);
    assert(!canonicalSurfaces.has(source), `surface alias source must not remain canonical: ${source}`);
  }

  const listedSurfaceValues = allCases()
    .filter((entry) => entry.kind !== 'static-contract')
    .flatMap((entry) => (entry.httpSurfaces ?? []).map(canonicalizeSurface));
  const listedSurfaces = new Set(listedSurfaceValues);
  const ownersBySurface = new Map();
  for (const entry of allCases()) {
    if (entry.kind === 'static-contract') {
      assert(
        (entry.httpSurfaces ?? []).length === 0,
        `static-contract case ${entry.caseId} must have empty httpSurfaces`,
      );
      continue;
    }
    for (const raw of entry.httpSurfaces ?? []) {
      assert(
        aliases[raw] === undefined,
        `case ${entry.caseId} lists alias surface ${raw}; use canonical ${aliases[raw]}`,
      );
      const surface = canonicalizeSurface(raw);
      const owners = ownersBySurface.get(surface) ?? [];
      owners.push(entry.caseId);
      ownersBySurface.set(surface, owners);
    }
  }
  for (const [surface, owners] of ownersBySurface) {
    assert(owners.length === 1, `canonical HTTP surface has ${owners.length} owners: ${surface} (${owners.join(', ')})`);
    assert(canonicalSurfaces.has(surface), `listed HTTP surface is not canonical: ${surface}`);
  }
  assert(
    listedSurfaceValues.length === listedSurfaces.size,
    'coverage ledger assigns one HTTP surface to multiple cases',
  );

  const unmapped = [...canonicalSurfaces].filter((surface) => !listedSurfaces.has(surface)).sort();
  const budget = parseMaxUnmapped();
  if (unmapped.length > budget) {
    fail(
      `canonical unmapped ${unmapped.length} exceeds budget ${budget}: ${unmapped.join(', ')}`,
    );
  }

  const expectedWebsockets = [...new Set(ledger.websocketPaths ?? [])].sort();
  assert(
    JSON.stringify(expectedWebsockets) === JSON.stringify(websocketPaths),
    `WebSocket inventory drifted: expected ${websocketPaths.join(',')}, ledger ${expectedWebsockets.join(',')}`,
  );
  assert(ledger.frontendRoutes === undefined, 'API-only ledger must not list frontendRoutes');
  assert(
    ledger.architecture?.testClient === 'node-fetch-api',
    'ledger must declare the node-fetch API client',
  );
  assert(
    Array.isArray(ledger.architecture?.forbiddenCompatibility)
      && ledger.architecture.forbiddenCompatibility.includes('browser journeys')
      && ledger.architecture.forbiddenCompatibility.includes('recovery profile'),
    'ledger must forbid browser journeys and the recovery profile',
  );
  assert(
    JSON.stringify([...ledger.intentKinds].sort()) === JSON.stringify([...intentKinds].sort()),
    'IntentKind inventory drifted from packages/common/src/enums.ts',
  );

  const inventory = ledger.inventory;
  if (inventory) {
    assert(inventory.controllerFileCount === new Set(
      httpDeclarations.filter((entry) => !isRetiredRoute(entry.surface)).map((entry) => entry.file),
    ).size, 'controller file inventory drifted');
    assert(inventory.httpDecoratorCount === httpDeclarations.length,
      'HTTP decorator inventory drifted');
    assert(inventory.canonicalHttpSurfaceCount === canonicalSurfaces.size,
      'canonical HTTP surface inventory drifted');
    assert(inventory.httpSurfaceCount === canonicalSurfaces.size,
      'HTTP surface inventory drifted');
    assert(inventory.intentKindCount === intentKinds.length,
      'IntentKind count drifted');
    assert(inventory.websocketPathCount === websocketPaths.length,
      'WebSocket path count drifted');
    assert(Number.isInteger(inventory.maxUnmapped) && inventory.maxUnmapped >= 0,
      'inventory.maxUnmapped must be a non-negative integer');
    if (maxUnmappedArg === undefined) {
      assert(unmapped.length <= inventory.maxUnmapped,
        `inventory.maxUnmapped ${inventory.maxUnmapped} is below canonical unmapped ${unmapped.length}`);
    }
  } else {
    warn('ledger.inventory is absent; run the validator once after route changes to freeze counts');
  }

  return { unmapped, listedCount: listedSurfaces.size };
}

function validateCases() {
  const cases = allCases();
  const ids = new Set();
  const markers = markerInventory();
  for (const entry of cases) {
    assert(!ids.has(entry.caseId), `duplicate coverage case ${entry.caseId}`);
    ids.add(entry.caseId);
    assert(ALLOWED_KINDS.has(entry.kind), `invalid kind for ${entry.caseId}`);
    assert(ALLOWED_STATUSES.has(entry.status), `invalid status for ${entry.caseId}`);
    assert(ALLOWED_PERSONAS.has(entry.persona), `invalid persona for ${entry.caseId}`);
    assert(Array.isArray(entry.profiles) && entry.profiles.length > 0,
      `case ${entry.caseId} must name at least one profile`);
    assert(entry.httpSurfaces === undefined || Array.isArray(entry.httpSurfaces),
      `case ${entry.caseId} httpSurfaces must be an array when present`);
    assert(entry.websocketPaths === undefined || Array.isArray(entry.websocketPaths),
      `case ${entry.caseId} websocketPaths must be an array when present`);
    assert(entry.intentKinds === undefined || Array.isArray(entry.intentKinds),
      `case ${entry.caseId} intentKinds must be an array when present`);
    assert(entry.frontendRoutes === undefined,
      `API-only case ${entry.caseId} must not list frontendRoutes`);
    assert(entry.requiredCapabilities === undefined || Array.isArray(entry.requiredCapabilities),
      `case ${entry.caseId} requiredCapabilities must be an array when present`);
    for (const profile of entry.profiles) {
      assert(ALLOWED_PROFILES.has(profile),
        `case ${entry.caseId} names unknown profile ${profile}`);
    }
    const markerGroup = markers.find((marker) => marker.caseId === entry.caseId)?.group;
    const group = entry.group ?? markerGroup;
    if (entry.group) {
      assert(
        existsSync(join(e2eRoot, 'specs', entry.group)),
        `case ${entry.caseId} group ${entry.group} is not a specs directory`,
      );
    }
    if (entry.status === 'implemented' && entry.kind !== 'static-contract') {
      assert(Boolean(group), `implemented case ${entry.caseId} has no group (set group or add a marker)`);
    }
  }

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
      assert(
        markersForCase.length === 1,
        `implemented case ${entry.caseId} must have exactly one marker, found ${markersForCase.length}`,
      );
    } else {
      assert(markersForCase.length === 0, `blocked case has a live marker: ${entry.caseId}`);
    }
  }

  for (const file of walk(join(e2eRoot, 'specs')).filter((path) => path.endsWith('.spec.ts'))) {
    const source = readText(file);
    assert(!/\.(skip|fixme|only)\s*\(/.test(source), `forbidden test modifier in ${file}`);
    assert(!/page\.(goto|locator|click|fill|route|screenshot|video|setContent)|snapshot\(/.test(source),
      `browser, mocking, or snapshot evidence in ${file}`);
    assert(!/async\s*\(\s*\{[^}]*\bpage\b/.test(source),
      `page fixture is forbidden in API-only spec ${file}`);
    assert(
      !/@playwright\/test|playwright\.request/.test(source),
      `Playwright is forbidden in API-only spec ${file}`,
    );
    assert(
      !/runCommand\(\s*['"]incus['"]/.test(source),
      `spec must use runIncus/execGuest instead of runCommand('incus'): ${file}`,
    );
    assert(
      !/startsWith\(['"]BLOCKED:['"]\)[\s\S]{0,400}\breturn\s*;/.test(source),
      `skip-as-pass blocked return is forbidden in ${file}`,
    );
  }
}

function validateSpecTree() {
  const specsRoot = join(e2eRoot, 'specs');
  assert(existsSync(specsRoot), 'e2e/specs is missing');
  const groups = readdirSync(specsRoot, { withFileTypes: true });
  const prefixes = [];
  for (const entry of groups) {
    if (!entry.isDirectory()) {
      fail(`specs root must only contain group directories: ${entry.name}`);
      continue;
    }
    const prefix = entry.name.match(/^(\d+)/)?.[1];
    if (prefix) prefixes.push(prefix);
    const specFiles = walk(join(specsRoot, entry.name)).filter((file) => file.endsWith('.spec.ts'));
    assert(
      specFiles.length > 0,
      `empty spec group ${entry.name} (every specs/<group> must contain a .spec.ts)`,
    );
  }
  assert(
    new Set(prefixes).size === prefixes.length,
    `duplicate numbered spec groups: ${prefixes.join(', ')}`,
  );
  assert(!existsSync(join(e2eRoot, 'e2e')), 'nested e2e/e2e/ must be removed');
  assert(!existsSync(join(e2eRoot, 'playwright.config.ts')),
    'retired playwright.config.ts must be removed');
  for (const file of [
    ...walk(join(e2eRoot, 'support')),
    ...walk(join(e2eRoot, 'fixtures')),
    join(e2eRoot, 'run.mjs'),
  ]) {
    const source = existsSync(file) ? readText(file) : '';
    assert(
      !/@playwright\/test/.test(source),
      `Playwright import is forbidden in ${relative(repoRoot, file)}`,
    );
  }
  assert(!existsSync(join(specsRoot, '70-browser')), 'retired specs/70-browser must be removed');
  assert(!existsSync(join(specsRoot, '75-browser')), 'retired specs/75-browser must be removed');
}

function validateProfiles() {
  const profilesDir = join(e2eRoot, 'profiles');
  const profileFiles = readdirSync(profilesDir).sort();
  assert(
    JSON.stringify(profileFiles) === JSON.stringify(['core.json', 'full.json', 'smoke.json']),
    `profiles/ must only contain smoke, core, and full JSON; found ${profileFiles.join(', ')}`,
  );
  assert(!existsSync(join(profilesDir, 'recovery.json')),
    'retired recovery profile must be removed');
  const markers = markerInventory();
  const loaded = {};
  for (const profileName of ['smoke', 'core', 'full']) {
    const yamlPath = join(profilesDir, `${profileName}.yaml`);
    assert(!existsSync(yamlPath), `retired profile yaml must be removed: ${profileName}.yaml`);
    const path = join(profilesDir, `${profileName}.json`);
    const profile = JSON.parse(readText(path));
    loaded[profileName] = profile;
    assert(profile.name === profileName, `profile name mismatch: ${profileName}`);
    assert(profile.runtime === 'incus', `profile ${profileName} must use Incus`);
    assert(profile.workers === 1, `profile ${profileName} must pin workers=1`);
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
    for (const entry of profileCases) {
      if (entry.status !== 'implemented' || entry.kind === 'static-contract') continue;
      const group = entry.group ?? markers.find((marker) => marker.caseId === entry.caseId)?.group;
      assert(Boolean(group), `implemented case ${entry.caseId} has no group for profile ${profileName}`);
      assert(
        profile.groups.includes(group),
        `case ${entry.caseId} is on profile ${profileName} but group ${group} is not in that profile`,
      );
    }
  }
  assert(
    JSON.stringify(loaded.smoke.groups) === JSON.stringify(['00-foundation', '15-iam']),
    'smoke must be API-only groups 00-foundation and 15-iam',
  );
  if (requiredProfile) {
    assert(ALLOWED_PROFILES.has(requiredProfile),
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
  'lan-bridge',
  'bridge-ipv4-filter',
  'private-simplestreams',
  'sshd-no-dhcp-image',
  'node-exporter-authenticated-pull',
  'intent-reconciliation',
  'exec-bridge',
  'ssh-reachability',
  'gpu-pci',
  'cephfs-cluster',
  'multi-server',
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
const decoratorSurfaces = new Set(
  declarations.filter((entry) => !isRetiredRoute(entry.surface)).map((entry) => entry.surface),
);
const aliases = ledger.surfaceAliases ?? {};
const canonicalSurfaces = new Set(
  [...decoratorSurfaces].map((surface) => aliases[surface] ?? surface),
);
const intentKinds = parseIntentKinds();
const websocketPaths = parseWebsocketPaths();

const coverage = validateLedger(
  declarations,
  decoratorSurfaces,
  canonicalSurfaces,
  intentKinds,
  websocketPaths,
);
validateCases();
validateSpecTree();
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
  + `${declarations.length} HTTP decorators, ${new Set(declarations.filter((entry) => !isRetiredRoute(entry.surface)).map((entry) => entry.file)).size} controller files, `
  + `${intentKinds.length} intent kinds, ${websocketPaths.length} WebSocket paths, `
  + `${allCases().length} coverage cases, `
  + `${coverage.listedCount} mapped / ${coverage.unmapped.length} unmapped `
  + `(budget ${ledger.inventory.maxUnmapped})`,
);
