#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const coverageRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const e2eRoot = resolve(coverageRoot, '..');
const repoRoot = resolve(e2eRoot, '..');
const ledgerPath = join(coverageRoot, 'features.yaml');
const current = JSON.parse(readFileSync(ledgerPath, 'utf8'));

if (current.schemaVersion !== 1) {
  throw new Error('sync-ledger-v2.mjs is an explicit schema-1 to schema-2 migration; refusing to rewrite another schema');
}

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function slash(path) {
  return path.split(sep).join('/');
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/:([a-z0-9]+)/g, 'by-$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const personas = {
  'foundation.runtime': 'platform-operator',
  'auth.identity-rbac': 'administrator-and-standard-user',
  'servers.inventory': 'cluster-administrator',
  'images.lifecycle': 'image-administrator-and-granted-user',
  'agent-tasks.durable-control': 'cluster-administrator-and-resource-owner',
  'containers.lifecycle-console': 'container-owner-and-administrator',
  'storage.local-quota': 'storage-user-and-administrator',
  'storage.remote': 'storage-administrator-and-granted-user',
  'network.macvlan': 'cluster-network-operator',
  'proxies.ssh-http': 'proxy-administrator-and-resource-owner',
  'observability.audit-settings': 'administrator-and-resource-owner',
  'browser.cpu-product': 'authorized-and-no-access-browser-user',
  'recovery.security': 'release-engineer-and-adversarial-client',
  'cleanup.release-evidence': 'release-engineer',
};

const fixtureTitles = new Map([
  ['foundation.runtime', new Set([
    'fresh migration',
    'two distinct CPU Agents',
    'systemd-managed dockerd',
    'XFS project quota',
  ])],
  ['servers.inventory', new Set(['create and register two servers'])],
  ['images.lifecycle', new Set(['pull on both nodes', 'immutable digest'])],
]);

const evidenceTitles = new Map([
  ['foundation.runtime', new Set(['current-build provenance'])],
  ['cleanup.release-evidence', new Set(current.features
    .find((feature) => feature.id === 'cleanup.release-evidence').cases)],
]);

const extraCases = {
  'foundation.runtime': [
    ['provider-boundary-contract', 'Docker DinD provider boundary is explicit', 'evidence',
      'topology provider metadata declares two nodes, shared-host-kernel scope, and unavailable capabilities without overclaiming',
      'evidence.foundation.docker-dind-provider-boundary-is-explicit'],
    ['public-settings-through-tls-edge', 'Public settings are reachable through the real TLS edge', 'behavioral',
      'GET /api/public/settings succeeds through HTTPS with the current run certificate trust',
      'api.foundation.public-settings.reachable'],
    ['frontend-login-through-tls-edge', 'Frontend login is served through the real TLS edge', 'behavioral',
      'the live /login document loads through HTTPS and exposes the real login controls',
      'browser.foundation.frontend-served-by-live-edge'],
  ],
  'auth.identity-rbac': [
    ['login-valid-anonymous-denied', 'Valid login and anonymous admin denial', 'behavioral',
      'a valid administrator session resolves /api/auth/me while an anonymous admin request is rejected',
      'api.auth.login.valid-and-anonymous-admin-denied'],
    ['api-token-create-list-delete', 'API token create, list, and delete lifecycle', 'behavioral',
      'a token is created with a one-time secret, appears in the owner list, is deleted, and remains absent',
      'api.auth.tokens.create-use-delete-owned-resource'],
  ],
  'servers.inventory': [
    ['seeded-cpu-agent-inventory', 'Seeded CPU Agent inventory is visible', 'fixture',
      'the two setup-created Agents are online, runtime-ready, distinct, and report no GPUs',
      'api.servers.two-real-cpu-agents-runtime-ready'],
  ],
  'images.lifecycle': [
    ['seeded-image-present', 'Seeded immutable workload is present on both Agents', 'fixture',
      'the setup-created image resolves to the immutable reference and both real Agents report successful pull tasks',
      'api.images.seeded-workload-present-on-both-real-agents'],
  ],
  'containers.lifecycle-console': [
    ['cpu-lifecycle-console-delete-smoke', 'Real CPU container lifecycle, console, and deletion proof', 'behavioral',
      'a real container is created, observed, executed, stopped, started, restarted, deleted, and physically converges absent',
      'api.containers.real-cpu-lifecycle-console-and-delete-proof'],
    ['gpu-field-rejected-cpu-scope', 'GPU request fields are rejected in CPU-only scope', 'behavioral',
      'a container create request containing gpuIndices is rejected by the real API before scheduling',
      'api.containers.cpu-scope-rejects-gpu-create-field'],
  ],
  'storage.local-quota': [
    ['agent-pquota-inventory', 'Agents report real XFS project-quota disks', 'behavioral',
      'both live Agent inventories include stable disk identity and at least one pquota-enabled absolute mount',
      'api.storage.agent-reports-real-pquota-disks'],
    ['mount-source-inventory-live', 'Mount-source inventory comes from the live control plane', 'behavioral',
      'GET /api/mount-sources returns the live inventory without a mocked response',
      'api.storage.mount-source-inventory-comes-from-live-agent'],
  ],
  'network.macvlan': [
    ['two-agent-inventories-cpu-only', 'Two Agent inventories remain CPU-only', 'fixture',
      'the setup-created Agents remain distinct, runtime-ready, and GPU-free',
      'api.network.two-agent-inventories-remain-cpu-only'],
  ],
  'proxies.ssh-http': [
    ['gateway-status-readable', 'SSH and HTTP proxy gateway status is readable', 'behavioral',
      'both real admin status endpoints return a typed online state without mocked transport',
      'api.proxies.real-gateway-status-readable'],
  ],
  'observability.audit-settings': [
    ['metrics-host-gpu-empty', 'Real host metrics and CPU-only GPU-series contract', 'behavioral',
      'the metrics backend returns host CPU data and an empty GPU series for a live CPU Agent',
      'api.observability.real-metrics-query-and-cpu-only-gpu-series'],
    ['audit-settings-readable', 'Audit and system settings are readable from the live control plane', 'behavioral',
      'real audit pagination and system-settings endpoints return their documented object and list shapes',
      'api.audit-and-settings.live-control-plane-readable'],
  ],
  'browser.cpu-product': [
    ['login-dashboard-journey', 'Browser login reaches the live dashboard without console errors', 'behavioral',
      'the administrator completes the real login form, leaves /login, renders the application, and emits no browser errors',
      'browser.auth.login-and-dashboard-real-journey'],
    ['anonymous-route-redirect', 'Anonymous protected route redirects to login', 'behavioral',
      'an anonymous browser visiting /users is redirected to the real login screen',
      'browser.auth.anonymous-protected-route-redirects-to-login'],
  ],
  'recovery.security': [
    ['runtime-fault-proof-contract', 'Runtime fault proof binds recovery to the current run', 'evidence',
      'the current run proof records a real fault, a changed generation, healthy convergence, and two ready Agents',
      'evidence.recovery.real-fault-applied-and-stack-converged'],
  ],
  'cleanup.release-evidence': [
    ['pre-down-resource-ownership', 'Every pre-down resource is owned by the current run', 'evidence',
      'the current manifest contains only named resources carrying the canonical run label or run-scoped name and no secret fields',
      'evidence.cleanup.every-live-resource-owned-by-current-run'],
  ],
};

const controllerRoot = join(repoRoot, 'packages', 'backend', 'src');
const surfacesByController = new Map();
for (const path of walk(controllerRoot).filter((entry) => entry.endsWith('.controller.ts')).sort()) {
  const source = readFileSync(path, 'utf8');
  const controller = source.match(/@Controller\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/);
  if (!controller) throw new Error(`cannot derive @Controller path from ${path}`);
  const controllerFile = slash(relative(controllerRoot, path));
  const surfaces = [...source.matchAll(
    /@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/g,
  )].map((match) => {
    const route = ['api', controller[1] ?? '', match[2] ?? ''].filter(Boolean).join('/');
    return `${controllerFile}|${match[1].toUpperCase()}|/${route}`;
  });
  surfacesByController.set(controllerFile, surfaces);
}

function fixtureProducer(featureId, title) {
  if (featureId === 'servers.inventory' || featureId === 'images.lifecycle') {
    return 'orchestrator/up.sh -> orchestrator/seed.mjs';
  }
  if (featureId === 'network.macvlan') return 'orchestrator/up.sh -> orchestrator/seed.mjs';
  return `topology/docker-dind setup (${title})`;
}

const features = current.features.map((feature) => {
  const persona = personas[feature.id];
  if (!persona) throw new Error(`missing persona mapping for ${feature.id}`);
  const httpSurfaces = feature.httpControllers.flatMap((controller) => {
    const surfaces = surfacesByController.get(controller);
    if (!surfaces) throw new Error(`${feature.id} references missing controller ${controller}`);
    return surfaces;
  }).sort();

  const cases = feature.cases.map((title) => {
    const kind = fixtureTitles.get(feature.id)?.has(title)
      ? 'fixture'
      : evidenceTitles.get(feature.id)?.has(title)
        ? 'evidence'
        : 'behavioral';
    const entry = {
      caseId: `${feature.id}.${slug(title)}`,
      title,
      kind,
      status: 'pending',
      profiles: [...feature.profiles],
      persona,
      assertions: [`${title} is exercised against the current-build live CPU stack with observable outcome and cleanup ownership`],
      specTestIds: [],
      httpSurfaces: [],
    };
    if (kind === 'fixture') entry.fixtureProducer = fixtureProducer(feature.id, title);
    return entry;
  });

  for (const [suffix, title, kind, assertion, specTestId] of extraCases[feature.id] ?? []) {
    const entry = {
      caseId: `${feature.id}.${suffix}`,
      title,
      kind,
      status: 'pending',
      profiles: [...feature.profiles],
      persona,
      assertions: [assertion],
      specTestIds: [specTestId],
      httpSurfaces: [],
    };
    if (kind === 'fixture') entry.fixtureProducer = fixtureProducer(feature.id, title);
    cases.push(entry);
  }

  for (const surface of httpSurfaces) {
    const [, method, apiPath] = surface.split('|');
    cases.push({
      caseId: `${feature.id}.http.${method.toLowerCase()}.${slug(apiPath)}`,
      title: `${method} ${apiPath} exact API contract`,
      kind: 'behavioral',
      status: 'pending',
      profiles: [...feature.profiles],
      persona,
      assertions: [
        `${method} ${apiPath} is invoked through the real TLS edge by the declared persona`,
        'success, denial, response shape, and durable state effects relevant to this route are asserted explicitly',
      ],
      specTestIds: [],
      httpSurfaces: [surface],
    });
  }

  return {
    id: feature.id,
    layer: feature.layer,
    group: feature.group,
    owner: feature.owner,
    profiles: [...feature.profiles],
    httpSurfaces,
    uiRoutes: feature.uiRoutes,
    agentTasks: feature.agentTasks,
    websockets: feature.websockets,
    specs: feature.specs,
    cases,
  };
});

const migrated = {
  schemaVersion: 2,
  scope: current.scope,
  baseline: current.baseline,
  closureContract: {
    statusSource: 'case-level current-run evidence; feature-level maturity strings are forbidden',
    pending: 'No closure credit. A marker may exist while assertions, endpoint coverage, or current-run evidence remain incomplete.',
    implemented: 'Eligible only when the exact case marker passes in the current Playwright report and post-down evidence validates.',
    fixture: 'A setup prerequisite only. Fixture events never count as behavioral HTTP or product-function coverage.',
    evidenceSchema: 'coverage/run-evidence.schema.json',
  },
  features,
};

writeFileSync(ledgerPath, `${JSON.stringify(migrated, null, 2)}\n`);
console.log(`migrated ${features.length} features and ${features.reduce((sum, feature) => sum + feature.httpSurfaces.length, 0)} exact HTTP surfaces to schema 2`);
