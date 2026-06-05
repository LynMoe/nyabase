# Tests

## Commands run

- `pnpm --filter @nyabase/frontend typecheck`
  - Result: PASS.

- `pnpm lint`
  - Result: PASS with 12 existing warnings and 0 errors.

- `bash scripts/check-visual.sh`
  - First run before baseline update: FAIL due to intentional authenticated full-page screenshot drift from sidebar text changing from `修改密码` to `用户中心`, plus the new `/profile` baseline.

- `pnpm --filter @nyabase/frontend exec playwright test --update-snapshots`
  - Result: PASS, 17/17.
  - Updated authenticated baselines and added `profile-user-center.png`.

- `bash scripts/check-visual.sh`
  - Result: PASS, 17/17.

- `pnpm --filter @nyabase/frontend exec playwright test e2e/management-routes.spec.ts -g "profile route" --update-snapshots`
  - Result: PASS, 2/2.
  - Re-generated profile baseline after the final add-key form layout and automatic naming changes.

- `pnpm --filter @nyabase/frontend exec playwright test e2e/management-routes.spec.ts -g "profile route"`
  - Result: PASS, 1/1 before the final behavior-test addition.

- `bash scripts/check-visual.sh`
  - Final visual result: PASS, 18/18.

- `bash scripts/check.sh`
  - Final result: PASS.
  - Common tests: 2 files / 41 tests passed.
  - Backend tests: 12 files / 98 tests passed.
  - Agent tests: 5 files / 71 tests passed.
  - Lint: 0 errors, 12 warnings.

- `find packages/common/src \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) | sort`
  - Result: no output.

## Coverage of acceptance criteria

- AC 1: Sidebar action reads `用户中心`, not `修改密码`.
  - Covered by `management-routes.spec.ts::profile route shows password and SSH key management`.

- AC 2: Clicking/navigating to `/profile` renders a user center page.
  - Covered by `management-routes.spec.ts::profile route shows password and SSH key management`.

- AC 3: Password change controls render.
  - Covered by `management-routes.spec.ts::profile route shows password and SSH key management`.

- AC 4: SSH public keys render from `/users/:id/ssh-keys`.
  - Covered by `management-routes.spec.ts::profile route shows password and SSH key management`.

- AC 5: Add/delete wiring exists through existing API endpoints.
  - Covered by typecheck, code review, and `management-routes.spec.ts::profile route generates an SSH key name when no comment is present`, which intercepts the add-key POST request body.

- AC 6: UI copy states keys are for container SSH login.
  - Covered by `management-routes.spec.ts::profile route shows password and SSH key management`.

- AC 7: No generated common source artifacts.
  - Covered by explicit `find` command and `scripts/check.sh`.

- AC 8: Add-key form puts public key content first, with public key and name on separate rows, and infers/generates names.
  - Covered by `management-routes.spec.ts::profile route shows password and SSH key management`.
  - Covered by `management-routes.spec.ts::profile route generates an SSH key name when no comment is present`.

## Visual artifacts

- `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/profile-user-center.png` (new)
- Authenticated full-page baselines updated because the sidebar user action text changed globally:
  - `packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/server-gpu-clock.png`
  - `packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/container-gpu-memory.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/dashboard-user-gpu-memory.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/dashboard-container-gpu-memory.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/servers-management.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/images-management.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/users-management.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/containers-own.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/data-dirs-overview.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/remote-fs-management.png`
  - `packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-detail-ssh-enabled.png`
  - `packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-detail-ssh-disabled.png`
  - `packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-console-toolbar-ip.png`

## Notes

- The first visual run failed only at screenshot comparison after assertions passed; updated baselines were then rerun deterministically.
- No product source was changed after the final `scripts/check.sh` run.
