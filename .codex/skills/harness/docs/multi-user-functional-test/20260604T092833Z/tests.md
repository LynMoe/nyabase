# Test Record

## Admin persona lane

- Verdict: PASS
- Command: `node .codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/admin-lane-probe.mjs`
- Target: `http://localhost:5173` using API proxy `http://localhost:5173/api`
- Counts: 45 passed / 0 failed / 0 skipped
- Full lane notes: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/admin-lane.md`
- Evidence: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/admin-lane-evidence.json`
- Visual artifacts: n/a; black-box functional lane

Acceptance coverage:

- AC #1: Admin authenticated, `/auth/me` returned current user/capabilities/groups, bad login and unauthenticated me were rejected.
- AC #2: Admin created two ordinary users, exercised user update/validation boundaries, group create/update/member flow, and group/direct server and image grants.
- AC #3: Ordinary-user permission boundaries were checked; handoff credentials are in `admin-lane.md`.
- AC #4: No product issues found; evidence file records observed statuses and response excerpts.

Handoff credentials:

- `admintest-20260604t093408-alpha` / `admintest-20260604t093408-A1pass!` - ordinary user with group-level server/image grants and `view_audit`/`view_metrics_all`.
- `admintest-20260604t093408-beta` / `admintest-20260604t093408-B2pass!` - ordinary user with direct server/image grants and no management capabilities.

## Ordinary user persona lane

- Verdict: FAIL
- Command: `node .codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-lane.spec.mjs`
- Target: `http://localhost:5173` using API proxy `http://localhost:5173/api`
- Counts: 15 passed / 4 failed / 0 skipped in harness evidence
- Unique product findings: 3
- Full lane notes: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-lane.md`
- Evidence: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-lane-evidence.json`
- Visual artifacts:
  - `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-profile.png`
  - `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-users-page-denied.png`

Acceptance coverage:

- AC #1: PASS. Simulated two ordinary users created by this lane plus the admin-lane beta handoff direct-grant ordinary user.
- AC #2: PASS with product findings. Direct API checks denied user/group/server/grant/audit/image-management actions for ordinary users; direct `/users` route still rendered admin UI.
- AC #3: PASS with product finding. Profile password, API token, valid SSH key, and cross-user SSH-key boundaries were exercised; invalid SSH key text was accepted.
- AC #4: PASS with product finding. Servers, images, access, and own containers were checked for per-user visibility; image detail leaked an unlisted image's metadata.
- AC #5: PASS. Reproduction steps, observed/expected behavior, impact, and evidence are in `ordinary-user-lane.md`.

Findings:

- Invalid SSH key accepted: ordinary user `POST /users/:id/ssh-keys` with `keyText: "not-an-ssh-public-key"` returned `201`; expected `400`.
- Image detail authorization leak: ordinary user could `GET /images/890ef43a-21bf-404d-82d8-7f4424ac3d67` with `200` although `/images` and `/me/access` excluded it; expected `403`.
- Direct admin UI route leak: ordinary user direct navigation to `/users` rendered `用户管理` and `添加用户` despite backing APIs returning `403`.

Cleanup / residue:

- Deleted throwaway users `ou20260604093841a` and `ou20260604093841b` plus SSH keys/API token created by this lane.
- Two lane-created containers remain stuck in `creating` with no Docker binding because API delete returns `409 Container has not been bound to Docker yet`: `5e1c4503-d766-47f4-960f-7c067a694899`, `ce8d4533-3d6c-477c-bd0b-1909db358933`.
- Used admin-lane beta handoff credential read-only: `admintest-20260604t093408-beta` / `admintest-20260604t093408-B2pass!`.

## Quota and SSH lane

- Verdict: FAIL
- Command: `pnpm exec vitest run .codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/quota-ssh-lane.spec.ts --reporter=verbose`
- Target: `http://localhost:5173` using API proxy `http://localhost:5173/api`
- Counts: 5 passed / 1 failed / 0 skipped
- Root cause: product
- Full lane notes: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/quota-ssh-lane.md`
- Evidence: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/quota-ssh-lane-evidence.json`
- Visual artifacts: n/a; black-box functional lane

Acceptance coverage:

- AC #1: PASS with product finding. Beta self SSH key list/add/list/delete passed; beta was denied alpha SSH-key list/add/delete with `403`; invalid SSH key validation failed.
- AC #2: PARTIAL. Existing admin-owned containers with SSH `running` were observed read-only; beta was denied SSH enable/reconcile on another user's container with `403`; no beta-owned container was available and handoff server was offline, so no safe owned SSH enable/reconcile was attempted. No disable endpoint was found.
- AC #3: PASS. Alpha group grant and beta direct grant were visible in `/me/access`; beta CPU/memory overrun creates returned `400` and did not create containers.
- AC #4: PASS with environment limitation. `/servers/:id/quota` returned beta `usedBytes: 0`, `limitBytes: 134217728` and alpha `usedBytes: 0`, `limitBytes: 67108864`; `/servers/:id/disks` returned `200 []`.
- AC #5: PASS. Repro steps, observed/expected behavior, impact, and evidence are in `quota-ssh-lane.md`.

Findings:

- Invalid SSH key accepted: beta `POST /users/be32921a-b857-4880-9486-fd47cc04e6cd/ssh-keys` with `keyText: "not-an-ssh-public-key"` returned `201` and persisted the bogus key; expected `400`. Test cleanup deleted the bogus key with `204`.

Cleanup / residue:

- Valid lane key `quota-ssh-20260604094305-beta-key` deleted with `204`.
- Bogus lane key `quota-ssh-20260604094305-bogus-key` deleted with `204`.
- Final sanity check: beta SSH key count `0`, beta container count `0`.
- Ordinary-user stuck containers were observed read-only and not modified: `5e1c4503-d766-47f4-960f-7c067a694899`, `ce8d4533-3d6c-477c-bd0b-1909db358933`.

## Container and mount lane

- Verdict: FAIL
- Command: `NYABASE_ALPHA_PASSWORD=<redacted> NYABASE_BETA_PASSWORD=<redacted> node .codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/container-mount-lane-followup.mjs`
- Target: `http://localhost:5173` using API proxy `http://localhost:5173/api`
- Counts: 33 passed / 1 failed / 0 skipped
- Root cause: product
- Full lane notes: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/container-mount-lane.md`
- Evidence: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/container-mount-lane-evidence.json`
- Probe artifact: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/container-mount-lane-followup.mjs`
- Visual artifacts: n/a; black-box functional lane

Acceptance coverage:

- AC #1: PASS with product finding. Container list/detail/create validation was exercised: missing body, invalid name/server/image, quota overage, ungranted mount source, owner/admin list, and stuck container detail.
- AC #2: PARTIAL with product finding. Start/stop/restart/delete were exercised on a lane-created unbound container and returned `409 Container has not been bound to Docker yet`; full lifecycle could not complete because create operations remained queued.
- AC #3: PASS with product finding. Local mount-source grant visibility, data-dir list/isolation/delete denial, owner mount inspection on a stuck mounted container, and cross-user mount-list denial were exercised. Remote source was observed on an offline server only, so remote behavior was limited to denial/inventory coverage.
- AC #4: PASS. Cross-user data-dir and mount isolation were probed; a concurrent data-dir create left one expected race winner. Container-create stuck behavior was compared across ordinary alpha input and admin plain input.
- AC #5: PASS. Reproduction steps, observed/expected behavior, impact, operation IDs, command IDs/statuses, delete responses, and residual IDs are in `container-mount-lane.md` and the evidence JSON.

Findings:

- Container create operations remain queued and never dispatch. Alpha mounted create `cml-20260604t094055z-alpha-c1` (`ca2f18bf-c380-4f04-a69a-e8ec079d59ed`) operation `12bc1ed5-deb3-493a-b4d4-b08897fa86d8` stayed `queued`; command `33aeb7f7-fe8e-4275-b330-cb79b02d503b` stayed `container.applySpec` / `pending` / `attempts: 0`. Admin plain create `cmlcmp-20260604t095421z-admin` (`79bcd2fb-7308-45e4-ac7a-19ad7991d0c1`) operation `88596d06-586e-47a6-ace9-060d398d89f3` also stayed `queued` with pending applySpec command after 20 seconds. Expected dispatch to online agent and terminal success/failure; impact is that create/detail/lifecycle/mount attach-detach cannot complete for new containers and API delete returns `409` while no Docker binding exists.

Cleanup / residue:

- Temporary online server/image/mount-source grants added by this lane for admin-lane alpha/beta were revoked with `204`.
- No stuck containers were deleted; delete was probed once and not waited on per PM/user instruction. Remaining lane containers: `ca2f18bf-c380-4f04-a69a-e8ec079d59ed`, `79bcd2fb-7308-45e4-ac7a-19ad7991d0c1`.
- Data dirs from the interrupted first run remain with lane prefix and should be cleaned only after stuck desired container/mount rows are resolved: `cml-20260604t094055z-alpha-dir`, `cml-20260604t094055z-race`.
- Used admin-lane handoff credentials for alpha/beta; passwords were supplied via env and not recorded in lane artifacts.
