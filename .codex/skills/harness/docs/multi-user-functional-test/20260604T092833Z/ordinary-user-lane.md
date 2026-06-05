# Ordinary User Persona Lane

## Scope

Black-box ordinary-user testing against the running nyabase system at `http://localhost:5173`, using the frontend proxy at `http://localhost:5173/api`. Product source was not modified.

## Command

```bash
node .codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-lane.spec.mjs
```

The final run exited nonzero because product findings were detected.

## Result

- Verdict: FAIL
- Counts: 15 passed / 4 failed / 0 skipped in harness evidence
- Unique product findings: 3
- Evidence: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-lane-evidence.json`
- Probe artifact: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-lane.spec.mjs`
- Screenshots:
  - `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-profile.png`
  - `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-users-page-denied.png`

## Credentials Used

Created by this lane, then deleted:

- `ou20260604093841a` / `ou20260604093841A123!`, changed during test to `ou20260604093841A234!`
- `ou20260604093841b` / `ou20260604093841B123!`

Handoff credential used read-only from admin lane:

- `admintest-20260604t093408-beta` / `admintest-20260604t093408-B2pass!`
- Source: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/admin-lane.md`

Admin setup credential used only for creating/deleting this lane's throwaway users and grants:

- `admin` / `admin123`

## Coverage

- AC #1: PASS. Simulated at least two ordinary-user sessions created by this lane (`ou20260604093841a`, `ou20260604093841b`) plus the admin-lane handoff beta direct-grant user.
- AC #2: PASS with findings below. Ordinary users were denied direct APIs for users, groups, server mutation, grant management, audit, image mutation, and admin disk/server token operations. Direct navigation to `/users` still rendered management UI; see Finding 3.
- AC #3: PASS with finding below. Self password update required current password, wrong current password was rejected, self status patch was ignored, API-token create/use/delete worked, SSH add/list/delete worked, cross-user SSH key APIs were denied. Invalid SSH key text was accepted; see Finding 1.
- AC #4: PASS with finding below. `/me/access`, `/servers`, `/images`, and `/containers?ownOnly=true` were checked for per-user filtering. Cross-user container detail/delete was denied. Direct image detail leaked metadata for an image absent from that user's list/effective access; see Finding 2.
- AC #5: PASS. Findings below include reproduction steps, observed behavior, expected behavior, impact, and evidence paths.

## Findings

### Finding 1: Invalid SSH public key text is accepted

- Root cause: product
- Reproduction:
  1. Login as ordinary user `ou20260604093841a`.
  2. `POST /api/users/d50b6c6f-7259-422b-8f8d-e00bf91bdb89/ssh-keys` with `{"name":"ou20260604093841-invalid","keyText":"not-an-ssh-public-key"}`.
  3. Observe `201` with a persisted SSH-key record.
- Observed: API persisted `keyText: "not-an-ssh-public-key"` and returned `201`.
- Expected: `400 Bad Request` for malformed SSH public key text.
- Impact: Users can save unusable or arbitrary strings as SSH keys; container SSH sync may receive invalid `authorized_keys` material.
- Evidence: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-lane-evidence.json`, finding `invalid SSH key accepted at profile user API`.

### Finding 2: Image detail endpoint leaks metadata outside effective access

- Root cause: product
- Reproduction:
  1. Login as ordinary user `ou20260604093841a`.
  2. Confirm `GET /api/images` only returns granted image `e6c7a01f-4431-4ac4-885e-bcf6ab755c60`.
  3. `GET /api/images/890ef43a-21bf-404d-82d8-7f4424ac3d67`.
  4. Observe `200` with full image metadata.
- Observed: `/api/images` filtered the image out, but `/api/images/:id` returned full metadata for `ubuntu-test`.
- Expected: image detail authorization should be at least as restrictive as `/images` list and effective access; expected `403`.
- Impact: Ordinary users can inspect image metadata outside their visible/usable grant set.
- Evidence: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-lane-evidence.json`, finding `user A can read ungranted image detail`.

### Finding 3: Direct `/users` navigation renders user-management UI for ordinary user

- Root cause: product
- Reproduction:
  1. Login through the frontend as ordinary user `ou20260604093841a`.
  2. Navigate directly to `http://localhost:5173/users`.
  3. Observe the user-management page shell and `添加用户` button.
- Observed: sidebar hides the admin Users nav item, but direct route renders `用户管理`, `0 个账号`, table headers, and `添加用户`.
- Expected: ordinary users should see an access-denied state or be redirected; admin-only management controls should not render.
- Impact: UI-level authorization gap and confusing disclosure of management surfaces. Backing APIs still returned `403` in API checks.
- Evidence: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/ordinary-user-users-page-denied.png`.

## Cleanup

- This lane deleted both throwaway users it created; subsequent admin reads returned `404`.
- The invalid and valid SSH keys and API token created for `ou20260604093841a` were deleted before deleting the user.
- Two throwaway containers created by this lane remain as cleanup residue because public API delete returns `409 Container has not been bound to Docker yet`:
  - `ou20260604093841a`, container id `5e1c4503-d766-47f4-960f-7c067a694899`, server `05cea385-d6ca-490a-a126-e00d0ae23b70`
  - `ou20260604093841b`, container id `ce8d4533-3d6c-477c-bd0b-1909db358933`, server `db1112fe-1c55-4314-9511-6d8510c523c2`
- No destructive cleanup outside the API was attempted.

## Notes

- The admin-lane beta handoff user was used read-only to confirm a direct-grant ordinary account has no management capabilities and is denied `/users`, `/groups`, and `/audit`.
- Container visibility checks passed: each ordinary user's `ownOnly=true` list contained only their own containers, and cross-user container detail/delete returned `403`.
