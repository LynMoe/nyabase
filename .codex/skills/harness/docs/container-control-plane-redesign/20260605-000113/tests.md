# Test And Regression Plan

This record summarizes the required gates for the incompatible container control-plane refactor. The authoritative detailed plan is `docs/container-control-plane-redesign.md`.

## Design Conformance Gate

Command:

```bash
pnpm run check:control-plane-redesign
```

Current state: expected to fail before implementation. Observed failures prove old routes, old agent command names, old frontend route file, and missing V2 services are still present.

The refactor cannot be accepted until this command passes.

## Required Regression Gates After Implementation

```bash
pnpm typecheck
pnpm test:unit
pnpm test:functional
bash scripts/check.sh
bash test/scripts/reset-local.sh
node test/scripts/register-agents.mjs
bash test/scripts/deploy-agents.sh
bash test/scripts/run-live-suite.sh smoke
bash test/scripts/run-live-suite.sh admin-setup
bash test/scripts/run-live-suite.sh personas
bash test/scripts/run-live-suite.sh continuation
pnpm run check:control-plane-redesign
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
```

## Coverage Requirements

- Backend unit tests for phases, action policy, operation terminal transitions, GPU error semantics, and orphan classification.
- Agent unit tests for V2 envelope parsing, mandatory labels, idempotency, and state reports.
- Frontend tests for action availability rendering and operation tracking.
- Live tests must wait for operation terminal state and `ContainerView.actions`, never raw list visibility.

## Current Verification Performed This Turn

- Ran `pnpm run check:control-plane-redesign`; it failed as expected because implementation is not done.
- Ran common-source artifact guard; no forbidden generated files under `packages/common/src`.

## Verification Performed In Latest Continuation

Passed:

```bash
pnpm typecheck
pnpm test:unit
pnpm test:functional
bash scripts/check.sh
pnpm run check:control-plane-redesign
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
```

Notes:
- `bash scripts/check.sh` completed successfully with ESLint warnings only.
- The conformance gate is now stricter: old `/containers` REST API strings in live tests, `spec.dockerId` identity reads in frontend/tests, and frontend lifecycle docker binding inference fail the gate.

Still required for final acceptance:
- Full live reset/register/deploy/smoke/admin-setup/personas/continuation suite.
- Runtime observation/orphan/exec/stats V2 production-path tests after those services are fully implemented.
