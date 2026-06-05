# Requirements

Original request: `部署最新代码在5173端口，前后端`

## Understood Scope

- Start the current workspace version of nyabase locally.
- Run the frontend dev server on port `5173`.
- Run the backend service required by the frontend.
- Avoid product source changes.
- Preserve existing user/workspace changes.

## Acceptance Criteria

1. Frontend is reachable on `http://localhost:5173/`.
2. Backend is running and reachable on its configured local port.
3. Any port conflicts are identified and handled without destructive workspace changes.
4. `packages/common/src/**` contains no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` artifacts.

## Gate Decisions

- CONFIRM_REQ: auto-skipped because the request is an unambiguous run/deploy task with no product design or code change.
- DESIGN / CONFIRM_DESIGN: skipped because no source implementation is required.

## Follow-up Requirement: repair API 500s and container operations

User follow-up: `修复`

Revised scope:

- Keep the local frontend on `http://localhost:5173/`.
- Keep the backend on `http://localhost:3001/api` using the populated test/deploy DB:
  `/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db`.
- Repair backend API failures for mount-source/container flows.
- Repair durable container command handling so container start/create no longer fails due stale schema or agent protocol drift.
- Rebuild and redeploy the remote test agents when the running agent binary is older than the current workspace code.
- Preserve the `packages/common/src/**` generated-artifact invariant.

Acceptance criteria:

1. `GET /api/mount-sources` and related server/data-dir endpoints return `200`, not `500`.
2. Container start returns an operation that reaches `succeeded`.
3. Container create returns `201` and its operation reaches `succeeded` with a non-empty `dockerId`.
4. Smoke containers created during verification are removed from Docker and the test DB.
5. `bash scripts/check.sh` exits `0`.

Gate decisions for this follow-up:

- CONFIRM_REQ: user explicitly requested `修复` after the failures were identified; proceeded with the narrow repair scope.
- CONFIRM_DESIGN: documented in `design.md`; proceeded because the repair was operationally blocking the requested deployment.
