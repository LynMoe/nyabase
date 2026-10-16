# Frontend visual QA

Local browser screenshot harness. **Not** product e2e and **not** Playwright in CI.

It starts (or reuses) the Vite app, mocks `/api/*` so no backend/Incus is required, logs in as an admin fixture, then captures desktop (1280×800) and mobile (390×844) shots of pages and dialogs.

```bash
pnpm --filter @nyabase/frontend visual:shots
```

Output: `packages/frontend/visual/shots/{desktop,mobile}/*.png` plus `manifest.json`.

Options (environment variables):

- `VISUAL_SHOTS_DIR=<dir>` — write somewhere else, e.g. to keep a before/after pair.
- `VISUAL_THEME=dark` — capture the dark theme.
- `VISUAL_ONLY=dashboard,dialog-create-container` — only the named shots.
- `VISUAL_FRESH_USER=1` — the signed-in user has no SSH key yet, to check the first-run prompts.

Uncaught page errors and error-boundary renders are printed as `[viewport] name: …` warnings, so a crash does not hide inside a screenshot.
