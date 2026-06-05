# Implementation Record: Harness Adaptation

Status: complete

## Changes

- Adapted active harness files to nyabase paths, `.codex/skills/harness`, pnpm commands, and `packages/*` package boundaries.
- Added mandatory session documentation conventions and created this session record.
- Added root verification scripts:
  - `scripts/check.sh`
  - `scripts/check-visual.sh`
- Added Playwright visual infrastructure:
  - `packages/frontend/playwright.config.ts`
  - `packages/frontend/e2e/login.spec.ts`
  - `packages/frontend/e2e/ROUTES.md`
  - `packages/frontend/e2e/__screenshots__/chromium/login.spec.ts/login-page.png`
- Added root package scripts: `check`, `check:visual`, and a usable root `lint`.
- Added frontend scripts: `test:visual`, `test:visual:update`.
- Added `@playwright/test` to `@nyabase/frontend` dev dependencies and updated `pnpm-lock.yaml`.
- Ignored Playwright transient output under `packages/frontend/e2e/.test-results/` and `.html-report/`.
- Removed old-project harness archive material that referenced stale visual/auth fixtures.

## Visual Impact

No product UI is intentionally changed. Visual impact is limited to creating a screenshot baseline for the existing `/login` route.

## Notes

- `scripts/check.sh` reports existing ESLint warnings but only fails on lint errors. The current repository has 13 pre-existing warnings unrelated to this infrastructure work.
- Playwright uses a dedicated Vite port (`4173`) and `reuseExistingServer: false` to avoid stale dev-server reuse.
