# Multi-user Functional Test Problem Report

## Executive Summary

- Target: running service at `http://localhost:5173`, API through `http://localhost:5173/api`.
- Time: 2026-06-04 session `20260604T092833Z`.
- Method: four concurrent tester lanes simulating administrator and ordinary-user personas.
- Overall result: FAIL due to product issues.
- Lanes:
  - Admin persona: PASS, 45/0/0.
  - Ordinary user persona: FAIL, 15/4/0, 3 unique product findings.
  - Quota and SSH: FAIL, 5/1/0, 1 product finding independently confirming SSH-key validation.
  - Container and mount: FAIL, 33/1/0, 1 product finding.

## Severity Ranking

### P0: Container create operations remain queued and never dispatch

- Area: containers, mounts, lifecycle, operations/outbox dispatch.
- Reproduced by: container/mount lane; also observed by ordinary-user and quota/SSH lanes.
- Repro:
  1. Login as an authorized user or admin.
  2. `POST /api/containers` against server `05cea385-d6ca-490a-a126-e00d0ae23b70` and image `e6c7a01f-4431-4ac4-885e-bcf6ab755c60`.
  3. Poll container detail/operation status.
- Observed:
  - Alpha mounted create `ca2f18bf-c380-4f04-a69a-e8ec079d59ed` operation `12bc1ed5-deb3-493a-b4d4-b08897fa86d8` stayed `queued`.
  - Its `container.applySpec` command `33aeb7f7-fe8e-4275-b330-cb79b02d503b` stayed `pending`, `attempts: 0`.
  - Admin plain create `79bcd2fb-7308-45e4-ac7a-19ad7991d0c1` operation `88596d06-586e-47a6-ace9-060d398d89f3` also stayed `queued` after 20 seconds.
  - New containers have no Docker binding; lifecycle actions and delete return controlled `409`.
- Expected:
  - Create operations should dispatch to the online agent, advance beyond `queued`, and reach either success or terminal failure with an actionable error.
- Impact:
  - New container creation is effectively broken in this environment.
  - Container lifecycle, detail, mount attach/detach, and SSH-on-owned-container testing cannot complete for newly created containers.
  - Stuck desired rows are left behind and cannot be cleaned through normal delete API.
- Evidence:
  - `container-mount-lane.md`
  - `container-mount-lane-evidence.json`
  - `tests.md` container/mount section

### P1: Invalid SSH public key text is accepted and persisted

- Area: users, SSH keys, container SSH sync.
- Reproduced by: ordinary-user lane and quota/SSH lane independently.
- Repro:
  1. Login as an ordinary user.
  2. `POST /api/users/:id/ssh-keys` with body `{"name":"bogus","keyText":"not-an-ssh-public-key"}`.
- Observed:
  - API returns `201`.
  - The malformed `keyText` is persisted and appears in subsequent list responses.
- Expected:
  - API should return `400 Bad Request` for malformed SSH public key material.
- Impact:
  - Users can save arbitrary non-key strings.
  - If container SSH reconciliation consumes these rows without later filtering, invalid lines may reach container `authorized_keys`.
- Cleanup:
  - Both lanes deleted their bogus keys after evidence capture.
- Evidence:
  - `ordinary-user-lane.md`
  - `ordinary-user-lane-evidence.json`
  - `quota-ssh-lane.md`
  - `quota-ssh-lane-evidence.json`

### P1: Image detail endpoint leaks metadata outside effective access

- Area: image authorization.
- Reproduced by: ordinary-user lane.
- Repro:
  1. Login as ordinary user `ou20260604093841a`.
  2. Confirm `GET /api/images` only includes the user's granted image.
  3. Directly request `GET /api/images/890ef43a-21bf-404d-82d8-7f4424ac3d67`.
- Observed:
  - `/api/images` filtered the image out.
  - `/api/images/:id` returned `200` with full metadata for an ungranted image.
- Expected:
  - Image detail authorization should be at least as restrictive as list/effective access; expected `403`.
- Impact:
  - Ordinary users can enumerate or inspect image metadata outside their grants if they know or guess IDs.
- Evidence:
  - `ordinary-user-lane.md`
  - `ordinary-user-lane-evidence.json`

### P2: Direct `/users` navigation renders user-management UI for ordinary users

- Area: frontend route authorization.
- Reproduced by: ordinary-user lane.
- Repro:
  1. Login through frontend as an ordinary user without `manage_users`.
  2. Navigate directly to `http://localhost:5173/users`.
- Observed:
  - Sidebar hides the Users nav item, but direct route renders `用户管理`, table headers, and `添加用户`.
  - Backing user-management APIs returned `403`, so this is UI-level authorization leakage rather than confirmed API bypass.
- Expected:
  - Ordinary users should be redirected or shown access denied; admin-only management controls should not render.
- Impact:
  - Confusing/disclosing admin management surface to unauthorized users.
- Evidence:
  - `ordinary-user-lane.md`
  - `ordinary-user-users-page-denied.png`

## Verified Behaviors

- Admin login, `/auth/me`, bad-login rejection, and unauthenticated rejection worked.
- Admin user CRUD, group create/update/member flow, group/direct server grants, and group/direct image grants worked.
- Ordinary user direct APIs for user/group/server/grant/audit/image mutation were mostly denied.
- Ordinary user self password update, API token create/use/delete, valid SSH key CRUD, cross-user SSH-key denial, and own-container visibility were exercised.
- Quota visibility through `/me/access` worked for handoff alpha/beta users.
- CPU and memory overrun container-create requests returned `400` and did not create beta containers.
- Ordinary users were denied SSH enable/reconcile on another user's SSH-running container.
- Mount/data-dir isolation checks passed where the environment allowed them.

## Coverage Gaps / Environment Limits

- Owned-container SSH enable/reconcile could not be fully tested because new container creation stayed queued and the beta handoff server was offline for that lane.
- Remote mount source behavior was limited to inventory/denial coverage because the observed remote source was on an offline server.
- Disk/pquota runtime rows were unavailable for the quota lane; `/servers/:id/disks` returned `200 []`.
- Full lifecycle start/stop/restart/delete could not be validated on new containers because no Docker binding was created.

## Cleanup / Residue

Do not remove these manually until the stuck desired container/operation rows are understood.

- Stuck ordinary-user lane containers:
  - `5e1c4503-d766-47f4-960f-7c067a694899`
  - `ce8d4533-3d6c-477c-bd0b-1909db358933`
- Stuck container/mount lane containers:
  - `ca2f18bf-c380-4f04-a69a-e8ec079d59ed`
  - `79bcd2fb-7308-45e4-ac7a-19ad7991d0c1`
- Container/mount lane data dirs:
  - `cml-20260604t094055z-alpha-dir`
  - `cml-20260604t094055z-race`
- Admin lane left handoff users/group/image for downstream testing; credentials are recorded in `admin-lane.md`.
- Admin lane notes also mention earlier dry-run data with prefix `admintest-20260604t093308` that was intentionally not deleted.

## Artifact Index

- Test record: `tests.md`
- Admin lane: `admin-lane.md`, `admin-lane-evidence.json`
- Ordinary user lane: `ordinary-user-lane.md`, `ordinary-user-lane-evidence.json`
- Ordinary user screenshots: `ordinary-user-profile.png`, `ordinary-user-users-page-denied.png`
- Container/mount lane: `container-mount-lane.md`, `container-mount-lane-evidence.json`
- Quota/SSH lane: `quota-ssh-lane.md`, `quota-ssh-lane-evidence.json`
