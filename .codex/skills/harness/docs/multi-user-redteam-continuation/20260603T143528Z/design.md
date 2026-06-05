# Multi-User Red-Team Continuation Design

Session: `multi-user-redteam-continuation/20260603T143528Z`
Role: architect

## Goal

Produce fresh 2026-06-03 live-runtime evidence for the remaining high-risk multi-user red-team areas: B6 quota enforcement, B9 concurrency/state stability, B10 metrics/audit/PromQL isolation, and B11 cleanup/residual scans.

## Interfaces

No product interface changes are planned. Tester/devops should use the current public API and host/runtime observation surfaces only.

| Area | Interfaces under test | Before/after |
| --- | --- | --- |
| Fixture validity | `POST /api/auth/login`, `GET /api/auth/me`, `GET /api/me/access`, `GET /api/servers`, `GET /api/images`, admin `GET /api/users/:id/effective-access` if creating fixtures | No shape change; prove either the prior five-user fixture is still valid or create a new exact-prefix five-user fixture. |
| Container quota | `POST /api/containers`, `GET /api/containers`, `GET/DELETE /api/containers/:serverId/:dockerId`, `POST /api/containers/:serverId/:dockerId/exec` | No shape change; `CreateContainerRequest` currently has no `diskBytes` field. CPU/memory/GPU are request-body checks; disk must be proven by XFS/write/quota observation. |
| Runtime quota evidence | Managed Docker socket, XFS project quota on CPU `/data` and GPU Docker root, `xfs_quota`, in-container writes through exec | No product API shape change; devops owns host-level reads/scans and any exact-prefix cleanup. |
| Metrics/audit | `GET /api/metrics/servers/:id/{host,gpus,users,containers}`, `GET /api/metrics/query`, `GET /api/metrics/query_range`, `GET /api/audit` | No shape change; verify normal-user PromQL rewriting cannot bypass `user_id` scoping and audit remains admin-only. |
| Stability/cleanup | Product API residual scans, managed Docker scans, host path scans, XFS `/etc/projects` and `/etc/projid` exact-prefix scans, service health probes | No shape change; prove convergence after concurrent operations and final teardown. |

## Data Model Changes

None. The continuation may create disposable users, groups, grants, images, containers, data dirs, mount sources, and runtime host artifacts under one exact run prefix: `murtc-<UTC>`. If prior fixture reuse is chosen, first prove all five non-admin users, grants, images, CPU/GPU servers, and source fixtures still exist and are usable; otherwise create a new exact-prefix fixture and record all non-secret IDs.

Secrets must be redacted everywhere: raw passwords, JWTs, refresh tokens, API-token secrets, agent tokens, SSH private keys, sudo credentials, and remote host credentials must not be written to session docs or reports.

## File-Level Change List

| Path | Expected change |
| --- | --- |
| `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/design.md` | Create this continuation test design. |
| `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/tests.md` | Tester/devops later append live batch evidence, commands/procedures, pass/fail classification, cleanup, and residual scans. |
| `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/implementation.md` | Create only if a product/test/infra failure requires a later fix dispatch. |
| `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/review.md` | Reviewer/PM later record final disposition. |

## Execution Plan

### B6 Fresh Quota Enforcement

Responsible lanes:

- Tester: user-state API operations with only each persona's JWT/API token; no host access and no admin token.
- Devops: host/runtime observation, XFS quota reports, managed Docker scans, admin-only fixture setup/cleanup.

Procedure:

1. Establish fixture validity for at least five non-admin users: alpha, beta, gamma, delta, epsilon or exact-prefix equivalents. Record `/me/access` for each user and admin effective-access readback if admin setup created or reused fixtures.
2. CPU quota: for alpha/beta/delta CPU grants, create below-limit and exact-remaining CPU containers, then over-limit and remaining-quota-exhaustion creates. Expected result: below/exact succeed; over and exhausted requests return `400` or `403`; rejected names do not appear in owner lists or Docker scans.
3. Memory quota: repeat the same below/exact/over/exhaustion pattern with `memBytes`. Expected result: no over-grant container row or runtime mutation remains.
4. GPU quota: for gamma `[0]` and delta `[1]`, create granted-index or `gpuCount=1` containers, reject ungranted index, duplicate/invalid index, and `gpuCount > grant`. Expected result: granted containers resolve only to allowed indices; denied requests leave no container/runtime residual.
5. Disk quota update from stale `TEST_OUTLINE.md`: do not send `diskBytes` in `POST /api/containers`; the current schema does not accept it. Prove disk quota through XFS-backed writable-layer or mounted data-dir writes: write below limit, observe quota/project usage, attempt over-limit write, capture no-space/failure behavior, and confirm hard-limit/accounting with `xfs_quota`.
6. For disk exact-boundary evidence, accept hard-limit readback plus below/over write behavior if exact-byte writes are brittle due to filesystem metadata. Record the rationale.

### B9 Fresh Concurrency And State Stability

Responsible lanes:

- Tester: launch near-concurrent user-state API operations from five separate credentials.
- Devops: observe post-convergence product/runtime state, IP uniqueness, quota totals, agent health, and exact-prefix residuals.

Procedure:

1. Run concurrent CPU create/delete bursts across alpha, beta, delta, and epsilon if epsilon has a tiny temporary grant.
2. Run concurrent GPU create/delete on gamma and delta using their distinct allowed indices.
3. Race remaining quota: two or more create requests that individually fit but collectively exceed remaining CPU or memory quota. Expected result: at most the allowed amount succeeds; all others are rejected without runtime mutation.
4. Run repeated lifecycle loops on a small subset: create, detail, stats, exec marker, stop/start/restart, delete.
5. Run concurrent data-dir/mount create/delete only if the live fixture includes the local/remote sources; otherwise record as already covered by 2026-06-02 mount closure and do not block this continuation.
6. After convergence, verify invariants: no duplicate IP allocation, no stuck `creating`/`deleting` containers, no state-cache mismatch after normal agent reconciliation, no over-quota aggregate live usage, no unexpected service degradation.

### B10 Fresh Metrics, PromQL, And Audit Isolation

Responsible lanes:

- Tester: normal-user metrics and audit denial probes from each user token.
- Devops/admin evidence: admin-only audit and `ViewMetricsAll` comparisons, without exposing secrets.

Procedure:

1. Create live CPU and GPU containers for at least two different users, generate small CPU/memory/disk/GPU activity where practical, and wait long enough for metrics samples.
2. Normal users query scoped endpoints: `/metrics/servers/:id/users`, `/containers`, `/host`, `/gpus`, and `/containers?all=true`. Expected result: accessible server checks pass, but user/container series expose only allowed owner data unless the actor has `view_metrics_all`.
3. PromQL bypass cases for normal users must include at least: direct victim selector, duplicate `user_id`, regex `user_id=~".*"`, negative matcher `user_id!="actor"`, `or` expressions, aggregation `sum by/without`, nested `rate(...)`, range query, metric names in string literals, selector-less `nyabase_*` metrics, and non-nyabase metrics such as `up`.
4. Acceptance for PromQL: returned data must contain no victim user id, username, container id/name, or GPU process attribution. If the endpoint returns `200`, inspect the JSON result; denial is also acceptable where product semantics allow it.
5. Admin verifies `/api/audit` after representative allowed and denied operations. Expected result: normal users cannot read audit; admin can see enough relevant allow/deny rows to link operation class, actor, target, status, and timestamp without storing secrets.

### B11 Cleanup And Residual Scan

Responsible lanes:

- Tester: user-state cleanup for resources each user created when permitted.
- Devops: exact-prefix product cleanup, host/runtime scans, and final health checks.

Procedure:

1. Delete containers before data dirs/mount grants; delete grants before image/user/group rows; delete API tokens and SSH keys before users where possible.
2. Scan product APIs for exact run prefix and manifest IDs: users, groups, images, server grants, image grants, mount grants, containers, data dirs, SSH keys, and API tokens.
3. Scan runtime surfaces for exact prefix/labels/IDs: CPU and GPU managed Docker containers, host data paths, mounted remote paths if used, XFS project/projid entries, and quota report residue.
4. Preserve unrelated resources. Any broad cleanup is forbidden.
5. Final health evidence must include backend auth guard `401`, frontend root `200`, VictoriaMetrics health/query `200`, CPU/GPU product server status online where expected, remote agent/managed Docker service active, and common-src artifact guard clean.

## Risks And Trade-Offs

- Prior 2026-06-02 evidence is strong for broad coverage but stale for live runtime; this design narrows continuation to fresh evidence for the identified gaps instead of repeating all B0-B5/B7/B8 flows.
- Disk quota cannot be validated through create-request `diskBytes` because `POST /api/containers` has no such field; XFS write/enforcement proof is more operationally realistic but needs devops host observation.
- PromQL rewriting is regex-based for `nyabase_*` selectors, so bypass tests must inspect actual returned labels and identifiers rather than relying only on HTTP status.
- Concurrent tests are timing-sensitive; acceptance is based on converged invariants and residual scans, not deterministic ordering.
- GPU cases depend on the currently green GPU host and image runtime; if a GPU precondition fails mid-run, classify exact cases `blocked-infra` and continue CPU/metrics/cleanup coverage.

Alternatives considered:

- Full rerun of B0-B11: rejected because prior session already closed broad persona/image/mount/isolation coverage and current ask is focused live batches.
- Disk quota via stale `diskBytes` create bodies: rejected because the current REST schema omits `diskBytes`; this would test invalid assumptions rather than product behavior.
- Metrics checks only through high-level endpoints: rejected because raw PromQL bypass was a prior failure class and needs direct fresh evidence.

## Acceptance Criteria

- Five-user validity is freshly proven: either five existing fixture users are still valid with current `/me/access` and effective grants, or a new exact-prefix five-user fixture is created and documented without secrets.
- B6 records CPU, memory, disk, and GPU quota evidence covering below-limit, exact or hard-limit proof, over-limit, remaining-quota exhaustion, and at least one race case.
- Disk quota evidence explicitly does not rely on create-request `diskBytes`; it uses XFS/project-quota readback plus below/over in-container or mounted-data writes.
- B9 records concurrent create/delete and lifecycle evidence across at least five users or a documented five-user fixture, with final invariants for no duplicate IPs, no stuck states, no quota oversubscription, and no state-cache mismatch.
- B10 records normal-user scoped metrics and raw PromQL bypass probes for direct selector, duplicate label, regex, negative matcher, `or`, aggregation, nested range/rate, selector-less metrics, and range query cases, with no victim identifiers returned.
- B10 records audit visibility: normal users denied from `/api/audit`; admin can observe representative sensitive allow/deny events with actor/target/status/timestamp and no secrets.
- GPU quota and metrics evidence covers gamma/delta granted indices and ungranted/over-count denial when GPU remains available; otherwise each GPU case is marked `blocked-infra` with exact current proof.
- Cleanup proves zero exact-prefix product rows and zero exact-prefix runtime residuals in managed Docker, host paths, XFS project/projid entries, data dirs, mounts, tokens, keys, grants, images, groups, and users.
- Final health and common-src artifact guard are green after cleanup.
- Every failure is classified as `fail-product`, `fail-test`, `fail-infra`, `blocked-infra`, or `not-applicable`, with the smallest rerun scope identified.

## Out Of Scope

- Product source, test, script, config, lockfile, or service changes unless a later failure dispatch explicitly routes a fix.
- Repeating already strong 2026-06-02 coverage for auth self-state, same Docker ref grants, inactive/deleted image grants, and mount-source runtime behavior except where needed as fixture setup for B6/B9/B10.
- Broad cleanup of unrelated product rows, Docker resources, host paths, or quota entries.
- Recording raw secrets or credentials.
