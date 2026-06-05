# Failure Root Cause And Systemic Fix Plan

Date: 2026-06-05

## 1. Mount-source live matrix

Observed failure: `console websocket timed out; output=`. Backend log shows console sessions connected and disconnected after the test timeout, with no output.

Root cause: exec input race.

Evidence:
- `ContainerControlService.openExecSession()` registers the session, sends agent RPC `execStream`, then returns `sessionId`.
- Agent `CommandDispatcher.handleExecStream()` ACKs immediately, then asynchronously starts Docker exec and only later stores handles in `execSessions`.
- `execInput` handling does `this.execSessions.get(p.sessionId)?.write(p.data)`; if browser input arrives before handles are stored, input is silently dropped.
- The mount test opens console and sends the command shortly after WS auth. When input is dropped, the shell waits forever and the test times out with empty output.

Systemic fix:
1. Make exec sessions stateful on the agent: pending/open/closing.
2. Buffer `execInput`, `execResize`, and `execClose` received before Docker exec handles are ready.
3. Flush buffered input/resize after handles are installed; if pending close exists, kill immediately.
4. Prefer ACKing `execStream` only after Docker exec stream is actually started and registered, or add an explicit `execReady` event before frontend/tests send input.
5. Add regression tests for input-before-handles-ready and close-before-handles-ready.

## 2. Dropbear live runtime

Observed failure: create operation failed inside Dropbear reconcile: `Container <dockerId> is not running`.

Root cause: runtime command contract is unsafe/implicit.

Evidence:
- Dropbear test creates an `ubuntu:24.04` image row with only `defaultUid: 0`; no `runtimeOverrides.cmd`.
- Image defaults are `{ entrypoint: null, cmd: null, init: false }`.
- Agent creates Docker containers with the image's entrypoint/cmd directly. Official Ubuntu/Alpine defaults are not guaranteed to be long-running in this context.
- Dropbear reconcile runs immediately after Docker start and requires `inspect.State.Status === 'running'`. If the image command exits, reconcile fails exactly as observed.

Systemic fix:
1. Define a product-level container runtime contract: interactive nyabase containers must have a long-running default process.
2. Enforce it in one place:
   - either require/validate admin image `runtimeOverrides.cmd` for interactive images;
   - or set a safe default command such as `sleep infinity` for images created via tests/fixtures;
   - or inject a nyabase keepalive command when cmd is null, if that is desired product behavior.
3. Update live fixtures (`admin-setup`, mount fixture, Dropbear fixture) to create images with explicit runtime overrides, e.g. `{ uid: 0, entrypoint: null, cmd: ['sleep', 'infinity'], init: true }`.
4. Before Dropbear reconcile, wait/poll briefly for container running state and record diagnostics, but do not use polling as a substitute for a valid runtime command.
5. Add regression tests: creating an SSH-enabled container from an image with explicit keepalive succeeds; creating from an image without a long-running cmd is rejected early or visibly marked as configuration error.

## 3. Visual gate

Root cause: visual e2e mocked API contract is stale, not live DB pollution.

Evidence:
- `scripts/check-visual.sh` runs Playwright against frontend Vite on 127.0.0.1:4173.
- Specs mostly use `page.route('**/api/**')` and return mock data; unhandled API paths return `{}`/404.
- Current frontend has moved to `/admin/...`, canonical container operation paths, and updated SSH/metrics/data-dir contracts while some e2e mocks still serve old routes.
- Failures include missing mocked data (`gpu-lab-01`, `SSH 访问`, `Lin Data SSD`) plus screenshot baseline drift.

Systemic fix:
1. Extract one shared visual API mock layer instead of per-spec ad-hoc route handlers.
2. Fail fast on unhandled API mocks; never silently return 404 for mocked visual tests.
3. Split admin vs normal-user fixtures and align all paths with current frontend API client.
4. First fix mock-contract failures until locator assertions pass; only then review and update screenshot baselines.
5. Keep mocked visual gate separate from live visual tests.

## Priority plan

P0:
- Fix agent exec input buffering/ready semantics.
- Add agent unit test for pre-ready input.
- Rerun mount matrix.

P1:
- Make test/live image runtime overrides explicit (`sleep infinity`, `init: true`).
- Add backend/fixture validation around runtime command contract.
- Rerun admin-setup/personas/mount/dropbear.

P2:
- Refactor visual e2e mock layer with unhandled-request fail-fast.
- Update mocks for current `/admin/*`, `/v2/*`, metrics, SSH, data-dir routes.
- Review and update screenshots after functional locator assertions pass.

P3:
- Add CI/runbook guards:
  - `check-live-fixtures` validates all live image fixtures have runtime overrides.
  - `check-visual-contract` fails on unhandled mock API.
  - preserve common-src artifact check.

