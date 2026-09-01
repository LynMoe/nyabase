# Nyabase testing

Layered, spec-driven tests. The live e2e contract is [`e2e-framework.md`](./e2e-framework.md).

## Layers

| Layer | Command | What it proves |
| :--- | :--- | :--- |
| L1 unit | `pnpm test:unit` | Pure logic in common / backend / node-exporter / frontend. Fake Incus is allowed here only. Frontend L1 = existing lib/store unit tests plus architecture helpers (query-lifecycle, query-presentation, query-keys, resource-mutation-gate, api-error) and optional jsdom layout tests for Page/EmptyState/ConfirmDialog. Never Playwright. Never a browser e2e. |
| L2 PG integration | backend `*.pg.test.ts` via `pnpm --filter @nyabase/backend test` | Persistence against PostgreSQL. |
| L3 contract | `pnpm --filter @nyabase/e2e validate` and `test:evidence` | HTTP/WS/intent inventory, unique surface ownership, orchestrator contracts. |
| L4 live e2e | `bash e2e/orchestrator/e2e.sh run <smoke\|core\|full>` | Real Incus control plane, Node `fetch` API client. Never faked. Never a browser. Never Playwright. |

`pnpm check` (GitHub PR CI) runs L1–L3, Rust proxy tests, lint, and typecheck. It does **not** start Incus.

Live smoke / core / full run only on a self-hosted `incus-e2e` runner (vmbr + dir/lvm pools + private simplestreams). GitHub-hosted runners must not run live Incus e2e.

## E2E inner loop

```bash
pnpm check
bash e2e/orchestrator/e2e.sh build "$RUN_ID" smoke
bash e2e/orchestrator/e2e.sh up "$RUN_ID" smoke
bash e2e/orchestrator/e2e.sh run smoke "$RUN_ID"
bash e2e/orchestrator/e2e.sh replay "$RUN_ID" smoke iam-admin-users
bash e2e/orchestrator/e2e.sh down "$RUN_ID"
```

Profiles:

| Profile | Groups | What it proves |
| :--- | :--- | :--- |
| `smoke` | `00-foundation`, `15-iam` | TLS health + IAM/catalog/settings/tokens. No live container, no SSH wait. |
| `core` | smoke + auth, servers, containers, storage, grants, proxies, bridged | Live Incus mutations and fail-closed boundaries. |
| `full` | core + metrics outage, restart reconcile, cleanup | Outage, restart, and teardown evidence. |

The lab uses a single PostgreSQL database plus run-id prefixes, `workers=1`. Each run is a new `runId`; there is no compatibility with prior runs or retired profiles.

## Adding a coverage case

1. Land the product controller / route / IntentKind / websocket.
2. `pnpm --filter @nyabase/e2e validate` fails (inventory or unmapped budget).
3. Give the surface exactly one owner in `e2e/coverage/features.json`.
4. Write `coverageCase('case-id', 'spec-test-id')` under the matching `e2e/specs/<group>/` using `adminApi` / `anonymousApi` only.
5. New topology capabilities go through the provider + doctor. Do not `if (!env) return`.
6. Re-run validate. On a live stack, replay the case. Evidence requires listed HTTP surfaces ⊆ observed.

GPU PCI and CephFS stay `BLOCKED` until hardware exists. Absent-reject probes must still run; never skip-as-pass.

## Ledger rules (schema v4)

- File: `e2e/coverage/features.json`.
- Statuses: `implemented` \| `blocked`. No `planned`.
- Every canonical HTTP surface has exactly one behavioral owner. `inventory.maxUnmapped` is `0`.
- Live specs are Node `fetch` API tests. Specs must not use Playwright, a `page` fixture, or frontend routes.
- Profiles live in `e2e/profiles/{smoke,core,full}.json` only.
