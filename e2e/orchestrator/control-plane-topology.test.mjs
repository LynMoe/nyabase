import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseVmagentQueueMetrics,
  validateInput,
} from './fault-control.mjs';

const orchestratorDir = dirname(fileURLToPath(import.meta.url));
const e2eRoot = resolve(orchestratorDir, '..');
const compose = readFileSync(
  join(e2eRoot, 'topology', 'docker-dind', 'compose.yaml'),
  'utf8',
);
const deployCompose = readFileSync(
  join(e2eRoot, '..', 'deploy', 'docker-compose.yml'),
  'utf8',
);
const edge = readFileSync(
  join(e2eRoot, 'topology', 'docker-dind', 'edge.conf'),
  'utf8',
);
const up = readFileSync(join(orchestratorDir, 'up.sh'), 'utf8');
const build = readFileSync(join(orchestratorDir, 'build.sh'), 'utf8');
const fixture = readFileSync(join(orchestratorDir, 'fixture-evidence.mjs'), 'utf8');
const health = readFileSync(join(orchestratorDir, 'health.sh'), 'utf8');
const proxyClient = readFileSync(
  join(orchestratorDir, 'proxy-client-control.mjs'),
  'utf8',
);
const recoveryProfile = JSON.parse(
  readFileSync(join(e2eRoot, 'profiles', 'recovery.yaml'), 'utf8'),
);
const faultControl = readFileSync(join(orchestratorDir, 'fault-control.mjs'), 'utf8');
const consoleSupport = readFileSync(
  join(e2eRoot, 'support', 'console.ts'),
  'utf8',
);
const containerMountLeaseSupport = readFileSync(
  join(e2eRoot, 'support', 'container-mount-lease.ts'),
  'utf8',
);
const recoverySpec = readFileSync(
  join(e2eRoot, 'specs', '80-recovery-security', 'recovery-security.live.spec.ts'),
  'utf8',
);

test('cold topology has one authoritative PostgreSQL volume and disposable Redis', () => {
  assert.match(compose, /^  postgres:\n/m);
  assert.match(compose, /image: postgres:18\.4-bookworm/);
  assert.match(compose, /POSTGRES_INITDB_ARGS: --data-checksums/);
  assert.match(compose, /^  postgres-data:\n/m);
  assert.doesNotMatch(compose, /^  (?:redis|backend)-data:\n/m);
  assert.match(compose, /--save '' --appendonly no/);
  assert.match(compose, /--maxmemory-policy allkeys-lfu/);
  assert.match(up, /pre-migration[\s\S]*docker_compose_for_run create/);
  assert.match(up, /empty-migration-volume[\s\S]*docker_compose_for_run up -d/);
  assert.match(fixture, /loadBackendMigrationManifest/);
  assert.match(fixture, /validateMigrationDatabaseEvidence/);
  assert.match(fixture, /Backend image migration manifest does not exactly match checked-in migrations/);
  assert.match(fixture, /pg_constraint/);
  assert.match(fixture, /pg_indexes/);
  assert.match(fixture, /live-readonly-psql-catalog-query/);
  assert.doesNotMatch(fixture, /better-sqlite3|sqlite_master|driver === 'sqlite'/);
  assert.match(health, /verify-migration/);
  assert.match(health, /postgres_migration_digest/);
  assert.doesNotMatch(health, /SELECT count/);
});

test('same Backend image is split into API, Gateway, and Worker without migration race', () => {
  for (const role of ['api', 'gateway', 'worker']) {
    assert.match(compose, new RegExp(`^  backend-${role}:\\n`, 'm'));
    assert.match(
      compose,
      new RegExp(
        `backend-${role}:[\\s\\S]*?NYABASE_RUNTIME_ROLE: ${role}[\\s\\S]*?DB_MIGRATIONS_RUN: "true"`,
      ),
    );
  }
  assert.match(compose, /backend-api:[\s\S]*?healthcheck:/);
  for (const role of ['gateway', 'worker']) {
    assert.match(
      compose,
      new RegExp(
        `backend-${role}:[\\s\\S]*?backend-api:\\n\\s+condition: service_healthy`,
      ),
    );
    assert.match(
      compose,
      new RegExp(
        `backend-${role}:[\\s\\S]*?backend-config/config.yaml:/etc/nyabase/config.yaml:ro`,
      ),
    );
  }
  assert.match(
    compose,
    /x-backend-common:[\s\S]*?backend-config:\/etc\/nyabase\n/,
  );
  const apiBlock = compose.slice(
    compose.indexOf('  backend-api:\n'),
    compose.indexOf('  backend-gateway:\n'),
  );
  assert.doesNotMatch(apiBlock, /backend-config\/config\.yaml:\/etc\/nyabase\/config\.yaml:ro/);
  assert.match(edge, /location ~ \^\/ws\/\(agent\|console\|ssh-proxy\|http-proxy\)\$/);
  assert.match(edge, /proxy_pass http:\/\/backend-gateway:3001/);
  assert.match(edge, /location \^~ \/api\/admin\/ssh-proxy\//);
  assert.match(edge, /location = \/api\/admin\/http-proxy\/status/);
  assert.equal(
    [...edge.matchAll(/proxy_pass http:\/\/backend-gateway:3001/g)].length,
    3,
    'only WebSockets and exact live Gateway administration may route to backend-gateway',
  );
  assert.match(edge, /location \//);
  assert.match(edge, /proxy_pass http:\/\/backend-api:3001/);
  assert.match(
    compose,
    /backend-gateway:[\s\S]*?NYABASE_CONSOLE_PUBLIC_URL: "wss:\/\/localhost:\$\{NYABASE_E2E_EDGE_PORT\}\/ws\/console"/,
    'primary Gateway must publish its browser-reachable TLS Console owner URL',
  );
});

test('Recovery provisions the real proxy clients required by split Gateway takeover', () => {
  assert.deepEqual(
    recoveryProfile.requiredCapabilities.filter((capability) =>
      capability === 'ssh-proxy' || capability === 'http-proxy'),
    ['ssh-proxy', 'http-proxy'],
  );
  for (const source of [build, up, health]) {
    assert.match(
      source,
      /NYABASE_E2E_PROFILE" == full \|\| "\$NYABASE_E2E_PROFILE" == recovery/,
    );
  }
  assert.match(
    proxyClient,
    /\['full', 'recovery'\]\.includes\(state\.NYABASE_E2E_PROFILE\)/,
  );
  assert.match(recoverySpec, /controlProxyClient[\s\S]*action: 'sshExec'/);
  assert.match(recoverySpec, /controlProxyClient[\s\S]*action: 'httpGet'/);
});

test('mount-source grants become visible to the current owner session', () => {
  assert.match(
    containerMountLeaseSupport,
    /this\.grantId = grant\.id[\s\S]*this\.input\.ownerApi\.post\('\/api\/data-dirs'/,
    'grant changes must become visible through the existing owner session',
  );
  assert.doesNotMatch(
    containerMountLeaseSupport,
    /refreshOwnerAuthentication/,
    'resource grant changes must not revoke the owner JWT',
  );
});

test('Backend cold start requires PostgreSQL but not disposable Redis or telemetry health', () => {
  const disposableDependency =
    /^\s+(?:redis|victoriametrics|vmagent):\n\s+condition: service_healthy$/m;
  const e2eCommon = compose.slice(
    compose.indexOf('x-backend-common: &backend-common\n'),
    compose.indexOf('\nservices:\n'),
  );
  assert.match(e2eCommon, /depends_on:\n\s{4}postgres:\n\s{6}condition: service_healthy/);
  assert.doesNotMatch(e2eCommon, disposableDependency);

  for (const [service, nextService] of [
    ['backend-gateway', 'backend-worker'],
    ['backend-worker', 'edge'],
  ]) {
    const block = compose.slice(
      compose.indexOf(`  ${service}:\n`),
      compose.indexOf(`  ${nextService}:\n`),
    );
    assert.match(block, /postgres:\n\s{8}condition: service_healthy/);
    assert.doesNotMatch(block, disposableDependency);
  }

  const deployBackend = deployCompose.slice(
    deployCompose.indexOf('  backend:\n'),
    deployCompose.indexOf('\nnetworks:\n'),
  );
  assert.match(deployBackend, /depends_on:\n\s{6}postgres:\n\s{8}condition: service_healthy/);
  assert.doesNotMatch(deployBackend, disposableDependency);

  for (const source of [compose, deployCompose]) {
    const vmagent = source.slice(
      source.indexOf('  vmagent:\n'),
      source.indexOf('  backend', source.indexOf('  vmagent:\n')),
    );
    assert.doesNotMatch(
      vmagent,
      /depends_on:\n\s+victoriametrics:\n\s+condition: service_healthy/,
    );
    assert.match(vmagent, /healthcheck:/);
  }
});

test('telemetry ingestion is vmagent-backed and both queues are durable', () => {
  assert.match(compose, /image: victoriametrics\/victoria-metrics:v1\.148\.0/);
  assert.match(compose, /image: victoriametrics\/vmagent:v1\.148\.0/);
  assert.match(compose, /-remoteWrite\.url=http:\/\/victoriametrics:8428\/api\/v1\/write/);
  assert.match(compose, /-remoteWrite\.tmpDataPath=\/vmagent-data/);
  assert.match(compose, /^  vm-data:\n/m);
  assert.match(compose, /^  vmagent-data:\n/m);
  assert.match(compose, /VICTORIA_METRICS_URL: http:\/\/victoriametrics:8428/);
  assert.match(compose, /VMAGENT_URL: http:\/\/vmagent:8429/);
});

test('vmagent persistent queue evidence parses current labelled metrics', () => {
  assert.equal(
    parseVmagentQueueMetrics([
      '# TYPE vm_persistentqueue_bytes_pending gauge',
      'vm_persistentqueue_bytes_pending{path="/vmagent-data/persistent-queue/a"} 17',
      'vm_persistentqueue_bytes_pending{path="/vmagent-data/persistent-queue/b"} 23',
    ].join('\n')),
    40,
  );
  assert.equal(
    parseVmagentQueueMetrics(
      'vmagent_remotewrite_pending_data_bytes{path="/queue", url="1:secret-url"} 0',
    ),
    0,
  );
});

test('fault vocabulary exposes independent split runtime, Redis, and telemetry controls', () => {
  const runId = 'architecture-fault-contract';
  for (const role of ['api', 'gateway', 'worker', 'all']) {
    assert.deepEqual(
      validateInput({ fault: 'backendService', runId, action: 'restart', role }, runId),
      { fault: 'backendService', runId, action: 'restart', role },
    );
  }
  assert.deepEqual(
    validateInput({ fault: 'redisService', runId, action: 'flush' }, runId),
    { fault: 'redisService', runId, action: 'flush' },
  );
  assert.deepEqual(
    validateInput({ fault: 'redisService', runId, action: 'stop' }, runId),
    { fault: 'redisService', runId, action: 'stop' },
  );
  for (const action of ['inject', 'probe', 'restore']) {
    const input = {
      fault: 'splitGatewaySessionRace',
      runId,
      nodeKey: 'node1',
      action,
      ...(action === 'inject'
        ? { staleExecSessionId: '11111111-1111-4111-8111-111111111111' }
        : {}),
    };
    assert.deepEqual(
      validateInput(input, runId),
      input,
    );
  }
  assert.deepEqual(
    validateInput(
      {
        fault: 'telemetryService',
        runId,
        service: 'victoriametrics',
        action: 'stop',
      },
      runId,
    ),
    {
      fault: 'telemetryService',
      runId,
      service: 'victoriametrics',
      action: 'stop',
    },
  );
  assert.throws(
    () =>
      validateInput(
        {
          fault: 'telemetryService',
          runId,
          service: 'victoriametrics',
          action: 'stop',
          command: 'docker rm',
        },
        runId,
      ),
    /unknown or missing fields/,
  );
});

test('split Gateway race uses current-build run-owned resources and exact cleanup', () => {
  assert.match(
    faultControl,
    /context\.state\.NYABASE_E2E_BACKEND_IMAGE/,
    'secondary Gateway must use the current run Backend image',
  );
  assert.match(
    faultControl,
    /io\.nyabase\.e2e\.component=\$\{splitGatewayRaceComponent\}/,
  );
  assert.match(
    faultControl,
    /recordManifestResource\(\s*'container',\s*identity\.secondaryGatewayContainer/,
  );
  assert.match(
    faultControl,
    /recordManifestResource\('container', identity\.secondaryEdgeContainer/,
  );
  assert.match(
    faultControl,
    /NYABASE_CONSOLE_PUBLIC_URL=\$\{identity\.secondaryConsoleUrl\}/,
    'secondary Gateway must persist its browser-reachable owner URL',
  );
  assert.match(
    faultControl,
    /127\.0\.0\.1:\$\{identity\.secondaryEdgeHostPort\}:443/,
    'secondary TLS edge must publish the run-state host port',
  );
  assert.match(
    faultControl,
    /recordManifestResource\(\s*'host-port',\s*identity\.secondaryEdgeHostPortResource/,
  );
  assert.match(
    faultControl,
    /retireManifestResource\(\s*'host-port',\s*identity\.secondaryEdgeHostPortResource/,
  );
  assert.match(
    faultControl,
    /retireManifestResource\('container', containerName, context\.runId\)/,
  );
  assert.match(faultControl, /splitGatewayRouteArgs[\s\S]*?'DNAT'/);
  assert.match(faultControl, /while \(await splitGatewayRouteActive/);
  assert.match(
    faultControl,
    /await docker\(\['pause', identity\.primaryGatewayContainer\]\)/,
    'primary Gateway must remain the same paused process while its lease expires',
  );
  assert.match(
    faultControl,
    /pausePrimaryGatewayAtDatabaseStablePoint[\s\S]*?pg_stat_activity[\s\S]*?locktype = 'advisory'/,
    'the frozen process must not retain transaction or advisory-lock authority',
  );
  assert.match(
    faultControl,
    /'ss',\s*'--kill'[\s\S]*?NYABASE_E2E_EDGE_IP/,
    'the selected real Agent connection must be cut without killing Gateway A',
  );
  assert.match(
    faultControl,
    /await docker\(\['unpause', identity\.primaryGatewayContainer\]\)/,
  );
  assert.match(
    faultControl,
    /releasedPrimary\.generation === state\.primaryGatewayProcessGeneration/,
    'unpause must release delayed cleanup from the exact original A process',
  );
  assert.match(faultControl, /assertStableAgentSessionOwner/);
  assert.match(
    faultControl,
    /closedExecSessionEvidence[\s\S]*?workflow\.exec_sessions[\s\S]*?row\.state === 'closed'/,
    'split takeover must prove stale and browser-closed exec sessions in PostgreSQL',
  );
  assert.match(
    faultControl,
    /await docker\(\['rm', '-f', containerName\]\)/,
    'cleanup must remove only exact label-validated transient containers',
  );
  assert.match(
    faultControl,
    /candidate\.gatewayId !== baseline\.gatewayId[\s\S]*candidate\.generation > baseline\.generation/,
  );
  assert.match(
    faultControl,
    /candidate\.sessionId === owner\.sessionId[\s\S]*candidate\.gatewayId === owner\.gatewayId/,
    'primary recovery must not steal the live secondary session',
  );
  assert.match(
    consoleSupport,
    /new URL\(consoleUrl, httpBase\)[\s\S]*if \(url\.protocol === 'http:'\) url\.protocol = 'ws:';[\s\S]*if \(url\.protocol === 'https:'\) url\.protocol = 'wss:';[\s\S]*url\.searchParams\.get\('sessionId'\) !== id/,
    'Console helper must consume the API owner URL, preserve ws(s), and upgrade only http(s)',
  );
  assert.doesNotMatch(
    consoleSupport,
    /new URL\('\/ws\/console', httpBase\)/,
    'Console helper must not silently fall back to the primary edge',
  );
  assert.match(
    recoverySpec,
    /execSession\.consoleUrl\)\.toBe\([\s\S]*injected\.secondaryConsoleUrl/,
  );
  assert.match(recoverySpec, /websocketUrl: ownerConsoleEndpoint\.toString\(\)/);
  assert.match(recoverySpec, /closeCode: 1000[\s\S]*closeWasClean: true/);
  assert.match(
    recoverySpec,
    /openPersistentConsoleUntilOutput[\s\S]*?staleExecSessionId: staleSession\.sessionId[\s\S]*?requirePersistentConsoleClosed/,
    'a pre-takeover A Console must be rejected and closed after B ownership',
  );
  assert.match(
    recoverySpec,
    /closeConsoleAfterOutput[\s\S]*?split-close-process-[\s\S]*?ps -eo args[\s\S]*?expectedClosedExecSessionIds/,
    'browser close must terminate the physical B exec and close durable authority',
  );
});
