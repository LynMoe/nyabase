# Worklog

- Classified as high-risk/release: backend semantics + DB observation + frontend shell/visual routes.
- Lead as implementer/devops/reviewer due no explicit subagent delegation request.

- Continued handoff at visual baseline/test-fix stage.
- Lead as implementer: fixed strict console status locator in `ssh-ux.spec.ts` so it no longer matches terminal text.
- Lead visual review: inspected fresh actual screenshots for GPU memory, dashboard container metrics, containers list, SSH enabled/disabled, and real shell console. Layout/text/state looked correct; shell view shows real xterm with mocked prompt and IP/status toolbar, not placeholder copy.
- Promoted six changed chromium baselines after review, then reran focused visual suite: `gpu-metrics.spec.ts`, `ssh-ux.spec.ts`, `management-routes.spec.ts` all 16 passed.

- Lead as implementer: fixed quota retry edge case found during personas rerun. A failed container create (for example live macvlan/IPAM `Address already in use`) no longer counts against CPU/memory/disk/GPU load accounting; failed create placeholders remain deletable but do not block replacement creates.
- Focused verification after quota fix: `pnpm --filter @nyabase/backend test -- src/containers/__tests__/resource-quota.policy.test.ts src/containers/__tests__/container-control-actions-v2.test.ts src/containers/__tests__/container-control-create-v2.test.ts` passed (41 tests).
- Lead as devops: restarted local backend/frontend from rebuilt backend, reused deployed agents, then reran live personas on the previously failing fixture; personas passed 6/6.
- Release/live verification after full fixes:
  - `bash test/scripts/run-live-suite.sh smoke` passed.
  - `bash test/scripts/run-live-suite.sh admin-setup` passed; fresh fixture `test/runtime/murt/20260605t033259z-f1426d/state.json`.
  - `bash test/scripts/run-live-suite.sh continuation` passed.
  - `bash test/scripts/run-live-suite.sh personas` passed 6/6.
  - `node test/scripts/create-mount-fixture.mjs && bash test/scripts/run-live-suite.sh mounts` passed; report `test/runtime/mount/20260605t033401z-2ca04d/mount-runtime-report.md`.
  - `bash test/scripts/run-live-suite.sh dropbear` passed; report `test/runtime/dropbear/20260605t033502z-50c94e/dropbear-live-report.redacted.md`.
  - Custom GPU/console/status probe passed with prefix `codex-20260605t033717-f2a107`; proved dockerDaemon readback, ordinary-user denial, grants, two active GPU containers sharing `[0]`, real WebSocket console, stats endpoint, GPU boundary denials, SSH conflict/enable, and exact prefix product cleanup.
- Release/static verification:
  - `bash scripts/check.sh --with-visual` passed: typecheck all workspaces, lint 0 errors/10 existing warnings, unit common/backend/agent 49/121/73 tests, Playwright visual 35/35.
  - `pnpm test:functional` passed 25/25.
  - `pnpm build` passed.
  - `pnpm build:frontend` passed.
  - `bash scripts/check-control-plane-redesign-conformance.sh` passed.
  - Common source artifact guard output empty.
- Lead visual review: re-opened `packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-console-toolbar-ip.png`; UI shows real xterm-style console panel with connected state and container IP, not the removed placeholder copy.
- Placeholder audit: product source grep found no remaining shell/console placeholder strings (`V2 控制台`, `exec 适配`, `占位`, `待实现`, `coming soon`, `not implemented`, `stub`). Only unrelated migration TODO remains.
