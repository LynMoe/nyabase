# Requirements

Session: `run-local-stack/20260602T030416Z`
Role: PM

## User Request

User asked: `完整运行起来，给我端口跟账号密码，我要上去测试`

## Scope

- Start the existing local nyabase stack for manual user testing.
- Report reachable frontend/backend/VictoriaMetrics ports.
- Report usable test login credentials.
- Verify the frontend and backend health/login path before returning details.

## Out of Scope

- Product code changes.
- Test code changes.
- Visual baseline changes.
- Agent redeployment unless startup verification shows the existing agents are down and devops can safely restart existing services.

## Gate Handling

- CONFIRM_REQ: auto-skipped because the user request is unambiguous and the task is run/deploy-only.
- DESIGN: skipped; no code or architecture change.
- CONFIRM_DESIGN: skipped because DESIGN is skipped.
- IMPLEMENT: skipped; no code change.
- TEST.visual / VISUAL_ACCEPTANCE: skipped; no rendered UI change is being made.

## Acceptance Criteria

1. Local backend is reachable on its configured port and `/api/auth/me` returns the expected unauthenticated response.
2. Local frontend is reachable and serves the app.
3. VictoriaMetrics is reachable or its container is running as expected.
4. A valid username/password pair is provided for manual testing.
5. Startup logs and any caveats are recorded in `tests.md`.
