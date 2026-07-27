# CPU E2E framework status

Date: 2026-07-27

## Current static status

- The fixed-host live suite and mocked visual/snapshot suite have been removed.
- The replacement runs one production Backend image as API/Gateway/Worker
  roles behind a real TLS edge, backed by PostgreSQL, disposable Redis,
  vmagent, and VictoriaMetrics, with two distinct systemd DinD nodes, cgroup
  v2, loop-backed XFS project quota, WSS Agents, Agent-owned dockerd instances, a private registry,
  real storage clients, and production SSH/HTTP proxy binaries.
- The executable inventory contains 236 implemented cases and no pending case:
  216 behavioral cases, eight run-bound fixture cases, and 12 evidence cases.
- Static validation maps exactly 153 HTTP surfaces across 29 controllers,
  20 frontend routes, 14 Agent task kinds, and four WebSocket paths. The exact
  HTTP inventory SHA-256 is
  `7321dfe34785478fffafd299b7a5af91401dd8b40029bec173c419d2a211fa5d`.
- This is static-contract closure only. It does not evaluate runtime evidence
  and does not certify the current worktree for release.
- Trace and video are disabled, screenshots are failure diagnostics only, and
  retained artifacts must pass the credential audit.

## Runtime release evidence

- Runtime release status is derived from a retained
  `e2e/.runtime/*-release-proof.json` only when its source and ledger
  fingerprints match the current worktree. Absence or mismatch means pending;
  historical profile artifacts are diagnostics, not certification.
- Release acceptance requires one uninterrupted current-source
  `e2e/orchestrator/run-full-release.sh` chain. It must produce Full A candidate
  exit 75, Full B closure exit 0, Recovery exit 0, identical source and ledger
  fingerprints, clean post-down manifests, and the aggregate release proof.

The validator currently reports `STATIC CONTRACT ONLY`; `EVIDENCE-VERIFIED` is
not claimed. The detailed architecture, evidence contract, limitations, and
evaluation are maintained in
[`docs/testing/cpu-e2e-architecture.md`](../../docs/testing/cpu-e2e-architecture.md).

## Intended certification boundary

Once the required aggregate proof exists for the final source, this release
gate certifies CPU behavior on the local DinD provider using real processes and
local kernel facilities. It never certifies GPU behavior, physical NIC/switch
behavior, firmware, bare-metal boot, or a kernel/distribution matrix. Missing
required infrastructure remains `BLOCKED`, never skipped or converted into a
pass.
