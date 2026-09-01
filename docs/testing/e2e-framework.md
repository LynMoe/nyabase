# Nyabase API-only E2E

| Field | Value |
| :--- | :--- |
| Date | 2026-08-28 |
| Runtime | Incus HTTPS mTLS, system containers, `nictype=bridged` on unmanaged `vmbr` |
| Client | Node `fetch` API only |
| Ledger | `e2e/coverage/features.json` schemaVersion 4, `maxUnmapped: 0` |

This is a clean break. Each run is a new `runId`. There is no recovery profile, no browser journey, no YAML ledger, and no compatibility with retired routes or prior run artifacts.

## Hard boundaries

- Control plane talks to standalone Incus over HTTPS + mTLS. No Agent, no Docker runtime, no macvlan.
- Workloads are system containers (`nyc-` / `nyv-` names). Topology probes may use `e2e-${runId}-*`.
- Storage families that must be live: `dir` + `quota_online`, `lvm` + `block_backed`.
- CephFS and GPU PCI are live on this lab (`shared-cephfs-storage`, `container-gpu-pci-claim`). Absent-reject still runs on hosts without GPU runtime. Skip-as-pass is forbidden.
- GitHub PR CI is `pnpm check` only. Live e2e runs on a self-hosted Incus lab (single PostgreSQL + run prefix, `workers=1`).

## Layers

1. Unit / PG tests (`pnpm test:unit`). Fake Incus is allowed here only.
2. Contract: `pnpm --filter @nyabase/e2e validate` and `test:evidence`.
3. Live: `bash e2e/orchestrator/e2e.sh run <smoke|core|full>`.

## Ledger

- Route source: `packages/backend/src/**/*.controller.ts`.
- Canonical HTTP surface count is pinned in `inventory`. Two `:imageId` decorator collisions are aliased; cases must list the canonical form.
- Every canonical HTTP surface has exactly one behavioral owner. Static-contract cases have empty `httpSurfaces`.
- `listed ⊆ observed` is enforced by `e2e/orchestrator/evidence.mjs` from `coverage-case-events.jsonl`.
- WebSocket paths (`/ws/console`, `/ws/ssh-proxy`, `/ws/http-proxy`) and `IntentKind` values are inventoried. They are not browser tests.

## Profiles

| Profile | Groups | Timeout | Intent |
| :--- | :--- | :--- | :--- |
| smoke | `00-foundation`, `15-iam` | 90s | Fast HTTP: health, IAM, catalog, settings, tokens. Seed still registers the Incus server, but tests do not create containers or wait on SSH. |
| core | smoke + `10-auth-rbac`, `20-servers-images`, `30-containers`, `35-user-ops`, `40-storage`, `50-access`, `55-proxies`, `70-network` | 300s | Live Incus mutations, grants, proxies, bridged LAN. |
| full | core + `60-observability`, `80-recovery`, `90-cleanup` | 420s | Metrics outage, restart reconcile, cleanup proof. |

`80-recovery` is a full-only spec group (restart/reconcile). It is not a fourth profile.

## Spec tree

```
e2e/specs/
  00-foundation/   health + seed contract
  10-auth-rbac/    personas, unauthorized, abuse
  15-iam/          admin users/groups, catalog, settings, tokens
  20-servers-images/
  30-containers/
  35-user-ops/
  40-storage/
  50-access/
  55-proxies/      HTTP and SSH proxy control-plane APIs
  60-observability/
  70-network/      bridged vmbr, not macvlan
  80-recovery/     restart/reconcile (full)
  90-cleanup/
```

Fixtures come from `e2e/fixtures/live-stack.ts` (`adminApi`, `anonymousApi`, `authedApiFactory`). Specs must not take a `page` fixture or import Playwright.

## Adding coverage

1. Add the product route.
2. Validate fails on inventory or unmapped.
3. Own the surface in exactly one case in `features.json`.
4. Hit it from the matching spec through the wrapped API client.
5. Replay on a live stack. Evidence fails if the case did not observe every listed surface.

## Forbidden

- Browser e2e, Playwright, `page.goto`, frontend route inventory.
- Recovery profile, YAML ledger/profiles, blanket `routeOwners`.
- In-process Incus simulators in e2e.
- `test.skip` / skip-as-pass for BLOCKED GPU or CephFS.
- `runCommand('incus')` in specs (use `runIncus` / `execGuest`).
- Raising `inventory.maxUnmapped`.
