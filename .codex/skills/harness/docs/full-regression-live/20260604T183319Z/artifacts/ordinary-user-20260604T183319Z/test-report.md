# Ordinary User Live Test Report

Verdict: FAIL
Verdict scope: ordinary-user live/UI/API report-only probes
Risk tier: live-test + release

## Scope
- Ordinary-user login/profile/access summary.
- Denial of admin-only API and direct admin UI routes.
- Granted servers/images/containers and quota/create behavior.
- Live create/delete from ordinary-user perspective.

## Commands / probes run
- `bash logs/ordinary-user-20260604T183319Z/preflight.sh` -> pass.
- `node artifacts/.../ordinary-user-readonly-probe.mjs artifacts/.../api-readonly-summary.json` -> pass for API auth/grants/denials.
- `node artifacts/.../ordinary-user-create-flow.mjs artifacts/.../api-create-flow.json` -> pass for CPU create/quota/cleanup.
- `pnpm --dir packages/frontend exec node ../../artifacts/.../ordinary-user-ui-probe.mjs ../../artifacts/.../ui` -> pass for login/profile/users-denied/create-dialog screenshots.
- `pnpm --dir packages/frontend exec node ../../artifacts/.../ordinary-user-ui-admin-routes.mjs ../../artifacts/.../ui-admin-routes` -> fail: several admin routes render management UI.
- `node artifacts/.../ordinary-user-gpu-count-probe.mjs artifacts/.../api-gpu-count-probe.json` -> fail: `gpuCount` ignored.

## Evidence artifacts
- Runtime fingerprint: `runtime-fingerprint.md`; raw preflight: `../../logs/ordinary-user-20260604T183319Z/preflight.log`.
- API read-only: `api-readonly-summary.json`, `../../logs/ordinary-user-20260604T183319Z/api-readonly-summary.txt`.
- CPU create/quota/cleanup: `api-create-flow.json`.
- GPU-count probe: `api-gpu-count-probe.json`.
- UI screenshots and summary: `ui/`, `ui/ui-summary.json`, `ui-admin-routes/admin-routes-summary.json`.
- Visual inspection: `visual-inspection-log.md`.
- Cleanup proof: `cleanup-ledger.md`, `cleanup-prefix-proof.json`.

## Failures / classification
1. Admin-only frontend routes are not consistently guarded for ordinary users.
   - Classification: product-bug.
   - Evidence: `ui-admin-routes/admin-routes-summary.json`; representative screenshots `ui-admin-routes/admin-route-images.png`, `ui-admin-routes/admin-route-manage_containers.png`.
   - Details: `/users` denies and `/servers` redirects, but `/images`, `/groups`, `/audit`, `/manage/containers`, `/manage/remote-fs` direct navigation renders admin/management page shells or controls. Backend API denies privileged endpoints with 403, so this is primarily frontend authorization/UX, not an observed backend data leak.

2. GPU create request using `gpuCount: 1` succeeds but creates a container with no GPU allocation.
   - Classification: product-bug.
   - Evidence: `api-gpu-count-probe.json` shows gamma has GPU grant `[0]`, create with `gpuCount:1` returned queued/succeeded/active, but readback resources are `gpuIndices: []`.
   - Impact: ordinary GPU user using the UI GPU quantity field can believe a GPU container was requested, while backend provisions a non-GPU container.

## Acceptance coverage
- AC1: covered by `api-readonly-summary.json` and screenshots `ui/01-login-page.png`, `ui/03-profile.png`, `ui/04-admin-users-denied.png`; API admin denial covered, UI denial partially failed as above.
- AC2: covered by `api-readonly-summary.json`; personas see only granted servers/images/containers; CPU quota overage returned 403 in `api-create-flow.json`.
- AC3: covered by `api-create-flow.json`; alpha created an active CPU container and cleanup succeeded.
- AC4: covered by UI screenshots under `ui/`.
- AC5: covered by failures above.

## Cleanup / residuals
- Created two prefixed containers; both deleted. `cleanup-prefix-proof.json` shows zero active matching rows.

## Status
- Report-only ordinary-user regression completed against the current live instance.
- Overall status: FAIL because two product bugs were found.
