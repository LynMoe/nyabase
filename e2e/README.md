# nyabase real CPU E2E

This package is the only product E2E framework in the repository. It replaces
the deleted fixed-host test scripts and mocked visual/snapshot suite with a
fresh, CPU-only stack that exercises:

`real browser/API -> TLS edge -> API/Gateway/Worker -> Agent -> Agent-owned dockerd -> real container`

The authoritative design is [CPU-only real E2E architecture](../docs/testing/cpu-e2e-architecture.md).

## Trust boundary

- No request mocking, fake Agent, fake Docker API, snapshots, visual baselines,
  test-body retries, broad TLS bypass, GPU fixture, or shared persistent host.
- The Docker provider creates two privileged systemd nodes, distinct machine
  IDs, cgroup v2, XFS project quota, Agent-owned dockerd, a TLS registry, fresh
  PostgreSQL state, disposable Redis, vmagent, VictoriaMetrics, and one
  production Backend image running separate API/Gateway/Worker roles.
- DinD uses real local kernel/runtime facilities but does not certify physical
  NICs, switches, firmware, bare-metal boot, or a kernel matrix. A future
  `ssh-baremetal` provider can reuse the same specs for those boundaries.
- Missing required infrastructure is `BLOCKED`; it is never converted to a
  skipped or passing test.

## Commands

Static framework and inventory validation is safe and does not start Docker:

```bash
pnpm e2e:validate
pnpm --dir e2e typecheck
```

The supported one-shot entry point owns build, startup, tests, diagnostics,
teardown, post-down evidence, and final profile validation:

```bash
pnpm test:e2e:smoke
pnpm test:e2e:core
pnpm test:e2e:full
pnpm test:e2e:recovery
```

An optional safe run ID may be supplied to the orchestrator directly:

```bash
bash e2e/orchestrator/e2e.sh run smoke my-cpu-run-001
```

Manual lifecycle commands require an explicit run ID so cleanup cannot target
an accidental default:

```bash
bash e2e/orchestrator/e2e.sh doctor my-cpu-run-001
bash e2e/orchestrator/e2e.sh build my-cpu-run-001
bash e2e/orchestrator/e2e.sh up my-cpu-run-001
bash e2e/orchestrator/e2e.sh health my-cpu-run-001
bash e2e/orchestrator/e2e.sh down my-cpu-run-001
```

## Profiles

| Profile | Scope | Current contract |
| --- | --- | --- |
| `smoke` | foundation, auth token, two Agents/image, one full container/Console lifecycle, cleanup | statically implemented; acceptance requires a current-source cold run |
| `core` | smoke plus RBAC, local storage/quota, network, metrics/audit, key browser journeys | statically implemented; acceptance requires current-source runtime evidence |
| `full` | every released CPU HTTP/UI/task/WS surface, NFS, CephFS, SSH and HTTP proxies | implemented; release acceptance requires the consecutive cold Full pair |
| `recovery` | isolated destructive restart, disconnect, drift, retry, quarantine and race cases | implemented; release acceptance requires a current-source Recovery run |

Profile selection is case-level. A passing smoke lane does not imply core or
full coverage. `coverage/features.yaml` currently inventories 153 exact Backend
HTTP surfaces across 29 controllers, 20 frontend route files, 14 Agent task
kinds, and four WebSocket paths; all 236 cases are implemented. Static
validation is not runtime evidence.

Runtime release status is determined only by a retained
`e2e/.runtime/*-release-proof.json` whose source and ledger fingerprints match
the current worktree. Historical or mismatched run directories never certify
it. When no matching proof exists, run
`e2e/orchestrator/run-full-release.sh` to produce the required same-source,
same-ledger Full A + Full B + Recovery chain with clean post-down evidence.

One profile run uses one Playwright worker because it owns a shared control plane,
two mutable Agents, and one XFS quota topology. Safe parallelism uses distinct
run IDs/topology slots; increasing workers inside a run is unsupported.

## Layers and ownership

Specs are grouped by stable product layer:

```text
00 foundation
10 auth and RBAC
20 servers, images, durable tasks
30 containers and Console
40 storage and quota
50 proxies and network
60 metrics, audit, settings
70 browser journeys
80 recovery and security
90 cleanup and release evidence
```

Every test has one `coverageCase(caseId, specTestId)` marker. Runtime API
contexts record the exact normalized HTTP surfaces reached by that test. The
post-run validator requires the marker, an all-green current-run Playwright
report, matching case events, current-worktree build provenance, and a clean
post-down manifest. Static mapping alone cannot close coverage.

When the minimal profile contract changes, update
`coverage/apply-profile-contract.mjs`, run it once without `--check`, then run
`pnpm e2e:validate`. The validator re-runs the sync contract in check mode and
fails on manual drift, duplicate ownership, stale endpoints, missing specs,
focused/skipped tests, mocks, snapshots, or forbidden visual artifacts.

## Runtime and evidence

Each run lives under `.runtime/<runId>/` with mode 0700. Generated credentials,
private keys, and Agent tokens are mode 0600 and are destroyed even when
`--keep-runtime` retains redacted evidence. Playwright trace/video are disabled;
screenshots exist only for failures.

A successful one-shot run preserves, at minimum:

- immutable build provenance and current image IDs;
- JSON/JUnit/HTML Playwright results;
- per-test HTTP/case events;
- product lifecycle and physical managed-dockerd deletion proof;
- credential-artifact audit;
- a post-down manifest proving zero labelled/prefixed Docker resources,
  mounts, loop devices, processes, ports, and retained secrets.

Any failed phase still enters the same scoped teardown. Cleanup failure wins
over a behavioral pass and makes the complete run fail.
