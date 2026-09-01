# Frontend visual QA

Local browser screenshot harness. **Not** product e2e and **not** Playwright in CI.

It starts (or reuses) the Vite app, mocks `/api/*` so no backend/Incus is required, logs in as an admin fixture, then captures desktop (1280×800) and mobile (390×844) shots of pages and dialogs.

```bash
pnpm --filter @nyabase/frontend visual:shots
```

Output: `packages/frontend/visual/shots/{desktop,mobile}/*.png` plus `manifest.json`.
