# Review: Dropbear SSH Rework

Session: 20260602T081822Z
Date: 2026-06-02T12:39:00Z

## Scope

This follow-up worker pass addressed the remaining Dropbear asset blocker only:

- archive the rebuild Dockerfile next to the asset;
- build the static Linux x64 Dropbear server from an official Dropbear source release;
- place the generated binary and sha256 sidecar at the agent default paths;
- verify binary shape, static linkage, sidecar match, help output, full check script, and standalone agent packaging.

The user explicitly requested no further design confirmation and direct execution.

## Findings

No blockers found.

## Verification

- `docker buildx build --platform linux/amd64 ...`: PASS after fixing the Dockerfile's missing `file` package.
- `sha256sum -c nyabase-dropbear-linux-x64.sha256`: PASS.
- `file packages/agent/assets/dropbear/nyabase-dropbear-linux-x64`: PASS, x86-64 static ELF.
- `ldd packages/agent/assets/dropbear/nyabase-dropbear-linux-x64 || true`: PASS, `not a dynamic executable`.
- `./packages/agent/assets/dropbear/nyabase-dropbear-linux-x64 -h`: PASS, reports Dropbear v2026.91 and advertises `-a`.
- `bash scripts/check.sh`: PASS.
- `bash scripts/build-agent-binary.sh`: PASS, produced `/root/nyabase/dist/nyabase-agent`.

## DoD Status

PASS for the requested follow-up. No frontend rendered output was changed in this pass, so visual acceptance is not applicable.

## Final Review After Live Runtime Test

Date: 2026-06-02T16:48:00Z

Verdict: PASS

Scope reviewed: `test/dropbear-live-runtime.spec.ts`, Dropbear session docs
`design.md`, `implementation.md`, `tests.md`, this `review.md`, live reports
under `/tmp/nyabase-dropbear-live-20260602t163601z-a1051d/`, and the
multi-user red-team session docs.

Blockers: none.

DoD checklist:

- [x] Final `bash scripts/check.sh` GREEN after live test-file changes
  (`tests.md`, section `Final Dropbear Live Standard Check`).
- [x] Live Dropbear user-state runtime coverage PASS: create-time SSH enable,
  disabled-to-enabled path, root public-key login, password/no-key rejection,
  cross-user denial, manual kill/reconcile repair, key add/delete sync, restart
  lifecycle, and cleanup.
- [x] Product API and CPU managed-Docker exact-prefix residual scans for all
  Dropbear live prefixes reported zero residuals.
- [x] Common source artifact guard clean.
- [x] Frontend visual gate not required for the final live test-only follow-up;
  earlier Dropbear frontend visual coverage remains recorded in `tests.md`.
- [x] Multi-user red-team final review remains PASS and is not contradicted by
  the Dropbear follow-up.

Final disposition: the previous live-runtime evidence gap for Dropbear SSH is
closed.
