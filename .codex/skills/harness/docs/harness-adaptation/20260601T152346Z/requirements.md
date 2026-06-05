# Requirements Record: Harness Adaptation

- Session: `20260601T152346Z`
- Date: 2026-06-01
- Request: read the existing harness skill and adapt it completely for this repository while preserving the main orchestration framework.

## Scope

- Adapt active harness rules from the old project layout to nyabase's pnpm workspace layout.
- Add mandatory records for requirements, design, implementation, tests, and review under `.codex/skills/harness/docs/<requirement>/<session>/`.
- Install Playwright for the frontend package.
- Add visual testing infrastructure and run an actual visual test.
- Preserve the main framework: PM orchestration, role boundaries, state machine, user gates, and DoD.

## Acceptance Criteria

1. Active harness docs reference `.codex/skills/harness`, `packages/*`, pnpm, and nyabase paths instead of old `.cursor`, root `frontend`, root `backend`, npm, or old project names.
2. The harness defines a session documentation flow grouped by requirement and session.
3. Playwright is available to `@nyabase/frontend`, with config, specs, route ledger, screenshots, and root check scripts.
4. A real Playwright visual run creates and verifies a baseline for at least one frontend route.
5. The root check flow includes typecheck, lint, unit tests, and the `packages/common/src` generated-artifact guard.

## Non-Goals

- Do not redesign product UI.
- Do not add authenticated visual fixtures until a nyabase-specific backend fixture recipe is designed.
- Do not change product behavior beyond test/tooling infrastructure.
