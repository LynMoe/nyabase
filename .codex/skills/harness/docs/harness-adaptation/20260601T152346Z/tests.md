# Test Record: Harness Adaptation

Status: complete

## Environment Setup

- Added `@playwright/test` to `@nyabase/frontend`.
- Ran `pnpm --filter @nyabase/frontend exec playwright install chromium`.
- First browser launch failed because the container lacked `libnspr4.so`.
- Ran `pnpm --filter @nyabase/frontend exec playwright install-deps chromium`, which installed required system libraries.

## Commands Run

```bash
pnpm --filter @nyabase/frontend exec playwright test --update-snapshots
```

Result: pass, `2 passed`; created `packages/frontend/e2e/__screenshots__/chromium/login.spec.ts/login-page.png`.

```bash
bash scripts/check-visual.sh
```

Result: pass, `2 passed`.

```bash
bash scripts/check.sh
```

Result: pass.

- Typecheck: `packages/common`, `packages/backend`, `packages/agent`, `packages/frontend` passed.
- Lint: exited 0 with 13 existing warnings and 0 errors.
- Unit tests:
  - `@nyabase/common`: 2 files, 36 tests passed.
  - `@nyabase/backend`: 7 files, 66 tests passed.
  - `@nyabase/agent`: 2 files, 15 tests passed.
- `packages/common/src` generated-artifact guard: passed.

```bash
bash scripts/check.sh --with-visual
```

Result: pass, including the same typecheck/lint/unit results plus Playwright visual `2 passed`.

## Visual Artifacts

- `packages/frontend/e2e/__screenshots__/chromium/login.spec.ts/login-page.png` (new baseline)
- `packages/frontend/e2e/.html-report/index.html` (generated, gitignored)
- `packages/frontend/e2e/.test-results/.last-run.json` (generated, gitignored)

## Residual Warnings

Root ESLint currently reports 13 warnings in existing source/test files. They are not new errors and were not fixed as part of this tooling task.
