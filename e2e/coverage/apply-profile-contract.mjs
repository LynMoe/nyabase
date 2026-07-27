#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ledgerPath = join(dirname(fileURLToPath(import.meta.url)), 'features.yaml');
const specsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'specs');
const checkOnly = process.argv.includes('--check');
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const currentBuildEvidenceProducer = 'orchestrator/coverage-evidence finalize (current build)';
const cleanupEvidenceProducer = 'orchestrator/coverage-evidence finalize (post-down cleanup)';
const consecutiveFullEvidenceProducer =
  'orchestrator/full-run-chain complete (two consecutive cold full runs)';

const implemented = new Map(
  Object.entries({
    'foundation.runtime.fresh-migration': {
      kind: 'fixture',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      fixtureProducer: 'topology/docker-dind setup (fresh migration)',
    },
    'foundation.runtime.two-distinct-cpu-agents': {
      kind: 'fixture',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      fixtureProducer: 'topology/docker-dind setup (two distinct CPU Agents)',
    },
    'foundation.runtime.systemd-managed-dockerd': {
      kind: 'fixture',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      fixtureProducer: 'topology/docker-dind setup (systemd-managed dockerd)',
    },
    'foundation.runtime.xfs-project-quota': {
      kind: 'fixture',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      fixtureProducer: 'topology/docker-dind setup (XFS project quota)',
    },
    'servers.inventory.create-and-register-two-servers': {
      kind: 'fixture',
      profiles: ['core', 'full'],
      httpSurfaces: [],
      fixtureProducer: 'orchestrator/up.sh -> orchestrator/seed.mjs',
    },
    'images.lifecycle.pull-on-both-nodes': {
      kind: 'fixture',
      profiles: ['core', 'full'],
      httpSurfaces: [],
      fixtureProducer: 'orchestrator/up.sh -> orchestrator/seed.mjs',
    },
    'images.lifecycle.immutable-digest': {
      kind: 'fixture',
      profiles: ['core', 'full'],
      httpSurfaces: [],
      fixtureProducer: 'orchestrator/up.sh -> orchestrator/seed.mjs',
    },
    'network.macvlan.two-agent-inventories-cpu-only': {
      kind: 'fixture',
      profiles: ['core', 'full'],
      httpSurfaces: [],
      fixtureProducer: 'orchestrator/up.sh -> orchestrator/seed.mjs',
    },
    'foundation.runtime.provider-boundary-contract': {
      profiles: ['smoke', 'core', 'full', 'recovery'],
      httpSurfaces: [],
    },
    'foundation.runtime.public-settings-through-tls-edge': {
      profiles: ['smoke', 'core', 'full', 'recovery'],
      httpSurfaces: [],
    },
    'foundation.runtime.http.get.api-health-live': {
      profiles: ['smoke', 'core', 'full', 'recovery'],
      httpSurfaces: ['health/health.controller.ts|GET|/api/health/live'],
    },
    'foundation.runtime.http.get.api-health-ready': {
      profiles: ['smoke', 'core', 'full', 'recovery'],
      httpSurfaces: ['health/health.controller.ts|GET|/api/health/ready'],
    },
    'foundation.runtime.frontend-login-through-tls-edge': {
      profiles: ['smoke', 'core', 'full', 'recovery'],
      httpSurfaces: [],
    },
    'foundation.runtime.current-build-provenance': {
      kind: 'evidence',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      evidenceSource: 'evidence',
      evidenceProducer: currentBuildEvidenceProducer,
    },
    'auth.identity-rbac.login-valid-anonymous-denied': {
      profiles: ['smoke', 'core', 'full'],
      httpSurfaces: [
        'auth/auth.controller.ts|POST|/api/auth/login',
        'auth/auth.controller.ts|GET|/api/auth/me',
        'users/admin-users.controller.ts|GET|/api/admin/users',
      ],
    },
    'auth.identity-rbac.api-token-create-list-delete': {
      profiles: ['smoke', 'core', 'full'],
      httpSurfaces: [
        'auth/auth.controller.ts|POST|/api/auth/tokens',
        'auth/auth.controller.ts|GET|/api/auth/tokens',
        'auth/auth.controller.ts|DELETE|/api/auth/tokens/:id',
      ],
    },
    'servers.inventory.seeded-cpu-agent-inventory': {
      kind: 'behavioral',
      profiles: ['smoke', 'core', 'full'],
      httpSurfaces: ['servers/admin-servers.controller.ts|GET|/api/admin/servers'],
    },
    'images.lifecycle.seeded-image-present': {
      kind: 'behavioral',
      profiles: ['smoke', 'core', 'full'],
      httpSurfaces: [
        'images/admin-images.controller.ts|GET|/api/admin/images/:id',
        'images/admin-images.controller.ts|GET|/api/admin/images/:id/status',
      ],
    },
    'containers.lifecycle-console.cpu-lifecycle-console-delete-smoke': {
      profiles: ['smoke', 'core', 'full'],
      httpSurfaces: [
        'containers/containers.controller.ts|POST|/api/v2/containers',
        'containers/containers.controller.ts|GET|/api/v2/containers/:containerId',
        'containers/containers.controller.ts|GET|/api/v2/containers/:containerId/stats',
        'containers/containers.controller.ts|POST|/api/v2/containers/:containerId/exec-sessions',
        'containers/containers.controller.ts|POST|/api/v2/containers/:containerId/actions/stop',
        'containers/containers.controller.ts|POST|/api/v2/containers/:containerId/actions/start',
        'containers/containers.controller.ts|POST|/api/v2/containers/:containerId/actions/restart',
        'containers/containers.controller.ts|POST|/api/v2/containers/:containerId/actions/delete',
      ],
    },
    'containers.lifecycle-console.gpu-field-rejected-cpu-scope': {
      profiles: ['smoke', 'core', 'full'],
      httpSurfaces: [],
    },
    'cleanup.release-evidence.pre-down-resource-ownership': {
      profiles: ['smoke', 'core', 'full', 'recovery'],
      httpSurfaces: [],
    },
    'cleanup.release-evidence.public-api-cleanup': {
      kind: 'evidence',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      evidenceSource: 'cleanup',
      evidenceProducer: cleanupEvidenceProducer,
    },
    'cleanup.release-evidence.inner-docker-cleanup': {
      kind: 'evidence',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      evidenceSource: 'cleanup',
      evidenceProducer: cleanupEvidenceProducer,
    },
    'cleanup.release-evidence.mount-and-loop-cleanup': {
      kind: 'evidence',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      evidenceSource: 'cleanup',
      evidenceProducer: cleanupEvidenceProducer,
    },
    'cleanup.release-evidence.outer-docker-cleanup': {
      kind: 'evidence',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      evidenceSource: 'cleanup',
      evidenceProducer: cleanupEvidenceProducer,
    },
    'cleanup.release-evidence.process-and-port-cleanup': {
      kind: 'evidence',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      evidenceSource: 'cleanup',
      evidenceProducer: cleanupEvidenceProducer,
    },
    'cleanup.release-evidence.label-and-prefix-zero-leak-proof': {
      kind: 'evidence',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      evidenceSource: 'cleanup',
      evidenceProducer: cleanupEvidenceProducer,
    },
    'cleanup.release-evidence.redacted-provenance': {
      kind: 'evidence',
      profiles: ['core', 'full', 'recovery'],
      httpSurfaces: [],
      evidenceSource: 'cleanup',
      evidenceProducer: cleanupEvidenceProducer,
    },
    'cleanup.release-evidence.two-consecutive-cold-full-runs': {
      kind: 'evidence',
      profiles: ['full'],
      httpSurfaces: [],
      evidenceSource: 'cleanup',
      evidenceProducer: consecutiveFullEvidenceProducer,
    },
  }),
);

// This is an explicit review boundary, not marker-driven auto-promotion. A new
// coverageCase marker remains pending until its case ID is deliberately added
// here after assertion/cleanup review. Exact one-surface cases retain the
// generated ledger surface; aggregate journeys claim only the overrides below.
const reviewedCaseIds = [
  'auth.identity-rbac.api-token-create-list-delete',
  'auth.identity-rbac.api-tokens',
  'auth.identity-rbac.administration-actions-projection',
  'auth.identity-rbac.audit',
  'auth.identity-rbac.catalog-grant-images-projection',
  'auth.identity-rbac.catalog-grant-servers-projection',
  'auth.identity-rbac.catalog-groups-projection',
  'auth.identity-rbac.catalog-users-projection',
  'auth.identity-rbac.direct-and-inherited-capabilities',
  'auth.identity-rbac.groups-and-nested-grants',
  'auth.identity-rbac.http.delete.api-admin-groups-by-id-mount-source-grants-by-sourcekind-by-sourceid',
  'auth.identity-rbac.http.delete.api-admin-users-by-userid-image-grants-by-imageid-by-serverid',
  'auth.identity-rbac.http.delete.api-admin-users-by-userid-mount-source-grants-by-sourcekind-by-sourceid',
  'auth.identity-rbac.http.get.api-admin-groups-by-id-mount-source-grants',
  'auth.identity-rbac.http.get.api-admin-users-by-id-internal-ssh-key',
  'auth.identity-rbac.http.get.api-admin-users-by-userid-image-grants',
  'auth.identity-rbac.http.get.api-admin-users-by-userid-mount-source-grants',
  'auth.identity-rbac.http.post.api-admin-groups-by-id-image-grants-by-imageid-sync-servers',
  'auth.identity-rbac.http.post.api-admin-groups-by-id-mount-source-grants',
  'auth.identity-rbac.http.post.api-admin-users-by-id-internal-ssh-key-rotate',
  'auth.identity-rbac.http.post.api-admin-users-by-userid-image-grants',
  'auth.identity-rbac.http.post.api-admin-users-by-userid-mount-source-grants',
  'auth.identity-rbac.http.post.api-auth-logout',
  'auth.identity-rbac.http.post.api-auth-refresh',
  'auth.identity-rbac.login-valid-anonymous-denied',
  'auth.identity-rbac.ownership-isolation',
  'auth.identity-rbac.refresh-and-logout',
  'auth.identity-rbac.revocation',
  'auth.identity-rbac.users-and-ssh-keys',
  'auth.identity-rbac.valid-and-invalid-login',
  'browser.cpu-product.all-routes-by-authorized-persona',
  'browser.cpu-product.all-routes-denied-for-no-access-persona',
  'browser.cpu-product.anonymous-route-redirect',
  'browser.cpu-product.loading-empty-error-and-convergence-states',
  'browser.cpu-product.login-and-logout',
  'browser.cpu-product.login-dashboard-journey',
  'browser.cpu-product.no-browser-console-errors',
  'browser.cpu-product.one-real-mutation-per-ui-capability-family',
  'cleanup.release-evidence.pre-down-resource-ownership',
  'containers.lifecycle-console.cpu-and-memory-limits',
  'containers.lifecycle-console.cpu-lifecycle-console-delete-smoke',
  'containers.lifecycle-console.create',
  'containers.lifecycle-console.cross-user-isolation',
  'containers.lifecycle-console.disk-limit',
  'containers.lifecycle-console.exec-and-console-traffic',
  'containers.lifecycle-console.gpu-field-rejected-cpu-scope',
  'containers.lifecycle-console.http.get.api-admin-v2-containers',
  'containers.lifecycle-console.http.get.api-admin-v2-containers-by-containerid',
  'containers.lifecycle-console.http.get.api-admin-v2-containers-by-containerid-stats',
  'containers.lifecycle-console.http.get.api-v2-containers',
  'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-delete',
  'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-reconcile-ssh',
  'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-restart',
  'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-start',
  'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-stop',
  'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-update-mounts',
  'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-exec-sessions',
  'containers.lifecycle-console.http.post.api-v2-containers-by-containerid-actions-reconcile-ssh',
  'containers.lifecycle-console.http.post.api-v2-containers-by-containerid-actions-update-mounts',
  'containers.lifecycle-console.mount-updates',
  'containers.lifecycle-console.name-and-capacity-conflicts',
  'containers.lifecycle-console.runtime-drift',
  'containers.lifecycle-console.ssh-reconciliation',
  'containers.lifecycle-console.start-stop-restart-delete',
  'foundation.runtime.frontend-login-through-tls-edge',
  'foundation.runtime.http.get.api-health-live',
  'foundation.runtime.http.get.api-health-ready',
  'foundation.runtime.provider-boundary-contract',
  'foundation.runtime.public-settings-through-tls-edge',
  'foundation.runtime.tls-edge',
  'foundation.runtime.unknown-websocket-rejection',
  'images.lifecycle.active-and-inactive-visibility',
  'images.lifecycle.create-and-update',
  'images.lifecycle.delete-and-ensure-absent',
  'images.lifecycle.failure-convergence',
  'images.lifecycle.seeded-image-present',
  'images.lifecycle.grant-enforcement',
  'images.lifecycle.http.delete.api-admin-images-by-id',
  'images.lifecycle.http.get.api-admin-images',
  'images.lifecycle.http.get.api-images',
  'images.lifecycle.http.get.api-images-by-id',
  'images.lifecycle.http.patch.api-admin-images-by-id',
  'images.lifecycle.http.post.api-admin-images',
  'images.lifecycle.http.post.api-admin-images-by-id-pull',
  'agent-tasks.durable-control.http.get.api-admin-agent-tasks',
  'agent-tasks.durable-control.http.get.api-admin-agent-tasks-by-taskid',
  'agent-tasks.durable-control.http.get.api-agent-tasks',
  'agent-tasks.durable-control.http.get.api-agent-tasks-by-taskid',
  'agent-tasks.durable-control.dispatch-retry',
  'agent-tasks.durable-control.effect-idempotency',
  'agent-tasks.durable-control.pending-to-terminal-transition',
  'agent-tasks.durable-control.resource-serialization',
  'agent-tasks.durable-control.result-validation',
  'agent-tasks.durable-control.retention-metadata',
  'agent-tasks.durable-control.user-and-admin-visibility',
  'network.macvlan.claim-reuse-delay',
  'network.macvlan.cross-node-ping-and-http',
  'network.macvlan.duplicate-claim-rejection',
  'network.macvlan.independent-client-reachability',
  'network.macvlan.same-node-traffic',
  'network.macvlan.unknown-inventory-fail-stop',
  'network.macvlan.unique-address-claims',
  'observability.audit-settings.admin-and-owner-authorization',
  'observability.audit-settings.audit-pagination-and-detail',
  'observability.audit-settings.audit-resource-snapshots',
  'observability.audit-settings.audit-settings-readable',
  'observability.audit-settings.catalog-metric-servers-projection',
  'observability.audit-settings.cpu-only-gpu-series-empty',
  'observability.audit-settings.editable-and-immutable-settings',
  'observability.audit-settings.host-cpu-memory-disk-and-network-metrics',
  'observability.audit-settings.http.get.api-admin-metrics-servers-by-id-containers',
  'observability.audit-settings.http.get.api-admin-metrics-servers-by-id-gpus',
  'observability.audit-settings.http.get.api-admin-metrics-servers-by-id-host',
  'observability.audit-settings.http.get.api-admin-metrics-servers-by-id-users',
  'observability.audit-settings.http.get.api-admin-metrics-runtime',
  'observability.audit-settings.http.get.api-admin-system-settings',
  'observability.audit-settings.http.get.api-audit',
  'observability.audit-settings.http.get.api-audit-by-id',
  'observability.audit-settings.http.get.api-metrics-servers-by-id-containers',
  'observability.audit-settings.http.get.api-metrics-servers-by-id-gpus',
  'observability.audit-settings.http.get.api-metrics-servers-by-id-host',
  'observability.audit-settings.http.get.api-metrics-servers-by-id-users',
  'observability.audit-settings.http.get.api-public-settings',
  'observability.audit-settings.http.patch.api-admin-system-settings',
  'observability.audit-settings.metrics-host-gpu-empty',
  'observability.audit-settings.public-setting-propagation',
  'observability.audit-settings.user-and-container-metrics',
  'proxies.ssh-http.binding-ownership-and-revocation',
  'proxies.ssh-http.disconnect-behavior',
  'proxies.ssh-http.gateway-status-readable',
  'proxies.ssh-http.host-key-rotation',
  'proxies.ssh-http.http-domain-pool-lifecycle',
  'proxies.ssh-http.http.delete.api-admin-http-proxy-domain-pools-by-id',
  'proxies.ssh-http.http.delete.api-v2-http-proxy-bindings-by-id',
  'proxies.ssh-http.http.get.api-admin-http-proxy-domain-pools',
  'proxies.ssh-http.http.get.api-admin-http-proxy-status',
  'proxies.ssh-http.http.get.api-admin-ssh-proxy-host-key',
  'proxies.ssh-http.http.get.api-admin-ssh-proxy-status',
  'proxies.ssh-http.http.get.api-v2-http-proxy-bindings',
  'proxies.ssh-http.http.patch.api-admin-http-proxy-domain-pools-by-id',
  'proxies.ssh-http.http.patch.api-v2-http-proxy-bindings-by-id',
  'proxies.ssh-http.http.post.api-admin-http-proxy-domain-pools',
  'proxies.ssh-http.http.post.api-admin-ssh-proxy-disconnect-all',
  'proxies.ssh-http.http.post.api-admin-ssh-proxy-host-key-rotate',
  'proxies.ssh-http.http.post.api-v2-http-proxy-bindings',
  'proxies.ssh-http.real-http-request-and-websocket-upgrade',
  'proxies.ssh-http.real-ssh-command-and-sftp',
  'proxies.ssh-http.ssh-proxy-online-and-host-key',
  'recovery.security.agent-reconnect',
  'recovery.security.authorization-race',
  'recovery.security.backend-restart-and-state-reconstruction',
  'recovery.security.dockerd-restart',
  'recovery.security.http.post.api-admin-servers-by-serverid-agent-quarantine-retry',
  'recovery.security.network-inventory-fail-stop',
  'recovery.security.pending-ssh-power-recovery-race',
  'recovery.security.quarantine-and-clear',
  'recovery.security.redis-disposable-outage-recovery',
  'recovery.security.retention-horizon-pruning',
  'recovery.security.runtime-drift-reconciliation',
  'recovery.security.runtime-fault-proof-contract',
  'recovery.security.secret-and-artifact-redaction',
  'recovery.security.split-gateway-session-takeover',
  'recovery.security.stale-session-fencing',
  'recovery.security.task-replay-and-idempotency',
  'recovery.security.victoriametrics-backlog-replay',
  'recovery.security.vmagent-bounded-degradation',
  'servers.inventory.disk-identity',
  'servers.inventory.cpu-only-inventory',
  'servers.inventory.capacity-and-deletion-guards',
  'servers.inventory.http.delete.api-admin-servers-by-id',
  'servers.inventory.http.get.api-admin-servers-all-disks',
  'servers.inventory.http.get.api-admin-servers-by-id',
  'servers.inventory.http.get.api-admin-servers-by-id-disks',
  'servers.inventory.http.get.api-admin-servers-by-id-self-check',
  'servers.inventory.http.get.api-servers',
  'servers.inventory.http.get.api-servers-by-id',
  'servers.inventory.http.get.api-servers-by-id-disks',
  'servers.inventory.http.get.api-servers-by-id-gpus',
  'servers.inventory.http.get.api-servers-by-id-quota',
  'servers.inventory.http.patch.api-admin-servers-by-id',
  'servers.inventory.http.post.api-admin-servers',
  'servers.inventory.http.post.api-admin-servers-by-id-regenerate-token',
  'servers.inventory.host-fingerprint-uniqueness',
  'servers.inventory.online-and-offline-state',
  'servers.inventory.seeded-cpu-agent-inventory',
  'servers.inventory.self-check',
  'servers.inventory.token-one-time-visibility-and-rotation',
  'storage.local-quota.agent-pquota-inventory',
  'storage.local-quota.data-directory-lifecycle',
  'storage.local-quota.http.delete.api-admin-data-dirs-by-serverid-by-sourceid-by-name',
  'storage.local-quota.http.delete.api-data-dirs-by-serverid-by-sourceid-by-name',
  'storage.local-quota.http.get.api-admin-data-dirs',
  'storage.local-quota.http.get.api-admin-data-dirs-issues',
  'storage.local-quota.http.get.api-data-dirs',
  'storage.local-quota.http.get.api-mount-sources',
  'storage.local-quota.http.post.api-admin-data-dirs',
  'storage.local-quota.http.post.api-data-dirs',
  'storage.local-quota.local-source-grants',
  'storage.local-quota.mount-source-inventory-live',
  'storage.local-quota.mount-persistence',
  'storage.local-quota.orphan-detection',
  'storage.local-quota.ownership-isolation',
  'storage.local-quota.concurrent-mutation',
  'storage.local-quota.quota-enforcement',
  'storage.local-quota.xfs-project-assignment',
  'storage.remote.busy-unmount-recovery',
  'storage.remote.catalog-grant-remote-fs-projection',
  'storage.remote.cephfs-create-assign-mount-unmount-delete',
  'storage.remote.credential-redaction',
  'storage.remote.http.delete.api-admin-remote-fs-mounts-by-id',
  'storage.remote.http.delete.api-admin-remote-fs-mounts-by-id-servers-by-serverid',
  'storage.remote.http.get.api-admin-remote-fs-mounts',
  'storage.remote.http.get.api-admin-remote-fs-mounts-by-id',
  'storage.remote.http.get.api-admin-remote-fs-mounts-by-id-servers',
  'storage.remote.http.patch.api-admin-remote-fs-mounts-by-id',
  'storage.remote.http.post.api-admin-remote-fs-mounts',
  'storage.remote.http.post.api-admin-remote-fs-mounts-by-id-servers',
  'storage.remote.mount-failure-convergence',
  'storage.remote.nfs-create-assign-mount-unmount-delete',
  'storage.remote.server-assignment-isolation',
];

for (const caseId of reviewedCaseIds) {
  if (!implemented.has(caseId)) implemented.set(caseId, {});
}

implemented.set('auth.identity-rbac.users-and-ssh-keys', {
  httpSurfaces: [
    'users/admin-users.controller.ts|POST|/api/admin/users',
    'users/admin-users.controller.ts|GET|/api/admin/users/:id',
    'users/admin-users.controller.ts|PATCH|/api/admin/users/:id',
    'users/admin-users.controller.ts|DELETE|/api/admin/users/:id',
    'users/admin-users.controller.ts|GET|/api/admin/users/:id/ssh-keys',
    'users/admin-users.controller.ts|DELETE|/api/admin/users/:id/ssh-keys/:keyId',
    'users/users.controller.ts|GET|/api/users/:id',
    'users/users.controller.ts|PATCH|/api/users/:id',
    'users/users.controller.ts|GET|/api/users/:id/ssh-keys',
    'users/users.controller.ts|POST|/api/users/:id/ssh-keys',
    'users/users.controller.ts|DELETE|/api/users/:id/ssh-keys/:keyId',
  ],
});
implemented.set('auth.identity-rbac.groups-and-nested-grants', {
  httpSurfaces: [
    'groups/groups.controller.ts|POST|/api/admin/groups',
    'groups/groups.controller.ts|GET|/api/admin/groups',
    'groups/groups.controller.ts|GET|/api/admin/groups/:id',
    'groups/groups.controller.ts|PATCH|/api/admin/groups/:id',
    'groups/groups.controller.ts|DELETE|/api/admin/groups/:id',
    'groups/groups.controller.ts|GET|/api/admin/groups/:id/members',
    'groups/groups.controller.ts|POST|/api/admin/groups/:id/members',
    'groups/groups.controller.ts|DELETE|/api/admin/groups/:id/members/:userId',
  ],
});
implemented.set('auth.identity-rbac.direct-and-inherited-capabilities', {
  httpSurfaces: [
    'groups/groups.controller.ts|GET|/api/admin/groups/:id/server-grants',
    'groups/groups.controller.ts|POST|/api/admin/groups/:id/server-grants/:serverId',
    'groups/groups.controller.ts|DELETE|/api/admin/groups/:id/server-grants/:serverId',
    'groups/groups.controller.ts|GET|/api/admin/groups/:id/image-grants',
    'groups/groups.controller.ts|POST|/api/admin/groups/:id/image-grants',
    'groups/groups.controller.ts|DELETE|/api/admin/groups/:id/image-grants/:imageId/:serverId',
    'groups/user-grants.controller.ts|GET|/api/admin/users/:userId/server-grants',
    'groups/user-grants.controller.ts|POST|/api/admin/users/:userId/server-grants/:serverId',
    'groups/user-grants.controller.ts|DELETE|/api/admin/users/:userId/server-grants/:serverId',
    'groups/user-grants.controller.ts|GET|/api/admin/users/:userId/effective-access',
    'groups/me-access.controller.ts|GET|/api/me/access',
  ],
});
implemented.set('storage.local-quota.local-source-grants', {
  httpSurfaces: [
    'mount-sources/admin-mount-sources.controller.ts|POST|/api/admin/mount-sources/grants/:sourceKind/:sourceId',
    'mount-sources/admin-mount-sources.controller.ts|GET|/api/admin/mount-sources/grants',
    'mount-sources/admin-mount-sources.controller.ts|DELETE|/api/admin/mount-sources/grants/:sourceKind/:sourceId/:scope/:scopeId',
  ],
});

function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? walk(child) : [child];
  });
}

const markerByCase = new Map();
const markerPattern =
  /\btest\s*\(\s*['"]([^'"]+)['"]\s*,\s*coverageCase\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
for (const specPath of walk(specsRoot)
  .filter((path) => path.endsWith('.spec.ts'))
  .sort()) {
  for (const match of readFileSync(specPath, 'utf8').matchAll(markerPattern)) {
    const [, , caseId, specTestId] = match;
    const markers = markerByCase.get(caseId) ?? [];
    markers.push(specTestId);
    markerByCase.set(caseId, markers);
  }
}

const caseIndex = new Map(
  ledger.features.flatMap((feature) =>
    feature.cases.map((coverageCase) => [coverageCase.caseId, coverageCase]),
  ),
);
for (const [caseId, contract] of implemented) {
  const coverageCase = caseIndex.get(caseId);
  if (!coverageCase) throw new Error(`implementation contract references missing case ${caseId}`);
  const markers = markerByCase.get(caseId) ?? [];
  if (contract.kind === 'fixture') {
    if (coverageCase.kind !== 'fixture')
      throw new Error(`fixture contract ${caseId} changed ledger kind`);
    if (markers.length > 0)
      throw new Error(`fixture contract ${caseId} must not have a coverageCase marker`);
    if (coverageCase.fixtureProducer !== contract.fixtureProducer) {
      throw new Error(`fixture contract ${caseId} producer drifted`);
    }
    contract.specTestIds = [];
  } else if (contract.kind === 'evidence' && contract.evidenceSource) {
    if (coverageCase.kind !== 'evidence')
      throw new Error(`finalized evidence contract ${caseId} changed ledger kind`);
    if (markers.length > 0)
      throw new Error(`finalized evidence contract ${caseId} must not have a coverageCase marker`);
    if (!['evidence', 'cleanup'].includes(contract.evidenceSource))
      throw new Error(`finalized evidence contract ${caseId} has invalid evidenceSource`);
    if (!contract.evidenceProducer)
      throw new Error(`finalized evidence contract ${caseId} lacks evidenceProducer`);
    contract.specTestIds = [];
  } else {
    if (markers.length === 0)
      throw new Error(`implemented case ${caseId} has no coverageCase marker`);
    contract.specTestIds = [...new Set(markers)].sort();
  }
  contract.profiles ??= coverageCase.profiles;
  contract.httpSurfaces ??= coverageCase.httpSurfaces;
}

const claimedSurfaces = new Set(
  [...implemented.values()].flatMap((entry) => entry.httpSurfaces ?? []),
);
const seenCases = new Set();
const seenSurfaces = new Set();

for (const feature of ledger.features) {
  const featureSurfaces = new Set(feature.httpSurfaces);
  feature.cases = feature.cases
    .filter((coverageCase) => {
      if (implemented.has(coverageCase.caseId)) return true;
      return !(coverageCase.httpSurfaces ?? []).some((surface) => claimedSurfaces.has(surface));
    })
    .map((coverageCase) => {
      const contract = implemented.get(coverageCase.caseId);
      if (contract) {
        seenCases.add(coverageCase.caseId);
        for (const surface of contract.httpSurfaces) {
          if (!featureSurfaces.has(surface)) {
            throw new Error(
              `${coverageCase.caseId} claims surface outside ${feature.id}: ${surface}`,
            );
          }
          if (seenSurfaces.has(surface))
            throw new Error(`duplicate smoke surface contract ${surface}`);
          seenSurfaces.add(surface);
        }
        return {
          ...coverageCase,
          ...(contract.kind ? { kind: contract.kind } : {}),
          status: 'implemented',
          profiles: contract.profiles,
          httpSurfaces: contract.httpSurfaces,
          specTestIds: contract.specTestIds,
          ...(contract.kind === 'fixture' ? { fixtureProducer: contract.fixtureProducer } : {}),
          ...(contract.kind === 'evidence' && contract.evidenceSource
            ? {
                evidenceSource: contract.evidenceSource,
                evidenceProducer: contract.evidenceProducer,
              }
            : {}),
          ...(contract.kind === 'behavioral' ? { fixtureProducer: undefined } : {}),
        };
      }
      return {
        ...coverageCase,
        status: 'pending',
        profiles: coverageCase.profiles.filter((profile) => profile !== 'smoke'),
        // Pending markers are intentional executable scaffolds. Keep their
        // stable IDs in the ledger so the pending-only Playwright tag remains
        // auditable, while status controls whether they count as coverage.
        specTestIds:
          coverageCase.kind === 'fixture'
            ? []
            : [...new Set(markerByCase.get(coverageCase.caseId) ?? [])].sort(),
      };
    })
    .map((coverageCase) =>
      Object.fromEntries(Object.entries(coverageCase).filter(([, value]) => value !== undefined)),
    );
}

for (const caseId of implemented.keys()) {
  if (!seenCases.has(caseId)) throw new Error(`smoke contract references missing case ${caseId}`);
}
for (const surface of claimedSurfaces) {
  if (!seenSurfaces.has(surface))
    throw new Error(`smoke contract surface was not assigned ${surface}`);
}

const formatted = `${JSON.stringify(ledger, null, 2)}\n`;
if (checkOnly) {
  if (readFileSync(ledgerPath, 'utf8') !== formatted) {
    throw new Error(
      'features.yaml is not synchronized; run node coverage/apply-profile-contract.mjs',
    );
  }
  console.log('coverage profile contract sync PASS');
} else {
  writeFileSync(ledgerPath, formatted);
  console.log(`coverage profile contract applied: ${implemented.size} reviewed cases implemented`);
}
