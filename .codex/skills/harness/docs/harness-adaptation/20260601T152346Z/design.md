# Design Record: Harness Adaptation

## Goal

Make the harness a nyabase-specific operating contract with mandatory per-session documentation and working visual test infrastructure.

## Key Decisions

- Use `.codex/skills/harness/docs/<requirement-slug>/<session-id>/` for process records. This keeps records inside the skill as requested while separating requirement identity from individual sessions.
- Keep the original state machine and user gates. The adaptation changes paths, commands, documentation ownership, and visual infrastructure locations.
- Put Playwright under `packages/frontend` and invoke it through `pnpm --filter @nyabase/frontend ...` so it matches the workspace package boundary.
- Start visual coverage with public `/login` and unauthenticated `/` redirect. Authenticated routes need a separate nyabase fixture design because backend auth/data setup is product-specific.

## File-Level Plan

- `.codex/skills/harness/SKILL.md`: rename/adapt project contract, workspace paths, documentation flow, visual paths, DoD.
- `.codex/skills/harness/workflow.md`: add session record requirements and update package paths/commands.
- `.codex/skills/harness/roles/*.md`: update role write scopes, commands, and docs ownership.
- `.codex/skills/harness/templates/*.md`: update dispatch/report templates and visual paths.
- `.codex/skills/harness/checklists/definition-of-done.md`: update hard gates and common-src artifact guard.
- `package.json`: add check scripts and make lint usable for this workspace.
- `scripts/check.sh`: root verification entry point; ESLint warnings are reported but only lint errors fail the check because existing warnings are outside this infrastructure change.
- `scripts/check-visual.sh`: visual verification entry point.
- `packages/frontend/package.json`: add Playwright scripts/dev dependency.
- `packages/frontend/playwright.config.ts`: configure Chromium, Vite webServer, reports, output, and snapshot paths.
- `packages/frontend/e2e/login.spec.ts`: baseline public visual coverage.
- `packages/frontend/e2e/ROUTES.md`: route coverage ledger.
- `.gitignore`: ignore Playwright output while keeping committed baselines.

## Risks

- Playwright browser/system dependencies may be missing on first run; devops must install Chromium and, if necessary, OS deps.
- Root lint may expose pre-existing issues because the previous root `lint` script was not wired to package scripts.
- Public visual coverage is only a baseline; authenticated route coverage remains future work.

## Acceptance Criteria Mapping

- AC1: active harness docs updated.
- AC2: session docs path and ownership defined in SKILL/workflow/roles.
- AC3: Playwright package/config/scripts/specs added.
- AC4: run update-snapshots once, then run visual check without update.
- AC5: `scripts/check.sh` added with typecheck/lint/unit/artifact guard.
