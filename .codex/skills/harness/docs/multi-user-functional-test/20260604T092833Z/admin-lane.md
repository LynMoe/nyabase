# Admin Persona Lane

## Scope

Black-box/admin-persona testing against the running nyabase system at `http://localhost:5173`, using the frontend proxy for API calls (`http://localhost:5173/api`). Product source was not modified.

## Command

```bash
node .codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/admin-lane-probe.mjs
```

## Result

- Verdict: PASS
- Counts: 45 passed / 0 failed / 0 skipped
- Evidence: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/admin-lane-evidence.json`
- Probe artifact: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/admin-lane-probe.mjs`
- Visual artifacts: n/a; black-box functional lane

## Coverage

- AC #1: PASS. Admin authenticated as `admin`; `/api/auth/me` returned current user, groups, and all expected management capabilities: `manage_users`, `manage_groups`, `manage_servers`, `manage_images`, `manage_grants`, `manage_containers_any`, `view_audit`, `view_metrics_all`. Bad admin password and unauthenticated `/auth/me` were rejected with `401`.
- AC #2: PASS. Admin created two ordinary users, rejected duplicate username and short password, patched another user's display name/password, created and updated a group, added a group member, and exercised group/direct server and image grants.
- AC #3: PASS. Permission boundaries checked from admin perspective and ordinary user perspective: ordinary users could not list/create users, read another user, list groups, inspect another user's effective access, or view audit without `view_audit`; self status patch was ignored for ordinary user. Created ordinary credentials are listed below for handoff.
- AC #4: PASS. No product issues found. Evidence file contains per-step observed statuses and response excerpts.

## Created Data

Final handoff users:

- `admintest-20260604t093408-alpha` / `admintest-20260604t093408-A1pass!`
  - User id: `fdb2a9c6-a3f5-407a-af36-b6072bd8f903`
  - Purpose: ordinary user with group-level server/image grants.
  - Group: `admintest-20260604t093408-operators` (`cbb19be3-b5a3-4e20-acbf-48bbefd9dda3`)
  - Granted server: `5336594b-4f9a-4cef-b389-3ef9aa1eca78`
  - Granted image: `59f6b47d-5b38-41b6-aff9-12193a4eeae5`
  - Extra group capabilities: `view_audit`, `view_metrics_all`

- `admintest-20260604t093408-beta` / `admintest-20260604t093408-B2pass!`
  - User id: `be32921a-b857-4880-9486-fd47cc04e6cd`
  - Purpose: ordinary user with direct server/image grants.
  - Granted server: `5336594b-4f9a-4cef-b389-3ef9aa1eca78`
  - Granted image: `59f6b47d-5b38-41b6-aff9-12193a4eeae5`
  - No management capabilities.

Other final-run resources:

- Group: `admintest-20260604t093408-operators` (`cbb19be3-b5a3-4e20-acbf-48bbefd9dda3`)
- Image: `admintest-20260604t093408-image` (`59f6b47d-5b38-41b6-aff9-12193a4eeae5`, docker ref `alpine:3.20`)
- API token: created and then deleted for beta as part of token boundary checks.

Earlier dry-run data with prefix `admintest-20260604t093308` was also created before probe bookkeeping was normalized. It was not deleted because the dispatch forbids deleting users/servers/containers unless cleanup is explicitly safe and no other lane depends on them.

## Checks Run

- Frontend shell reachable at `http://localhost:5173`.
- Unauthenticated `/api/auth/me` rejected.
- Bad admin password rejected.
- Admin login returned all expected management capabilities.
- Admin `/api/auth/me` returned current user, capabilities, and groups.
- Admin listed users.
- Admin created two ordinary users.
- Duplicate username rejected.
- Short password rejected.
- Admin updated another user's display name and password.
- Old password rejected after admin password update.
- Updated password authenticated successfully.
- Ordinary user could not list users.
- Ordinary user could not create users.
- Ordinary user could not read another user detail.
- Ordinary user's self status patch was ignored.
- Admin listed groups.
- Ordinary user could not list groups.
- Admin created group with capability.
- Admin updated group capabilities and priority.
- Admin added group member.
- Group capabilities appeared in ordinary user's `/api/auth/me`.
- User with `view_audit` but no `manage_users` could not list users.
- Admin listed servers.
- Admin added group server grant.
- Admin added direct user server grant.
- Granted ordinary user could see granted server.
- Admin listed images.
- Admin created image.
- Admin read newly created image detail.
- Admin added group image grant.
- Admin added direct user image grant.
- Granted ordinary user could see granted image.
- Admin inspected effective access for group-granted user.
- Admin inspected effective access for direct-granted user.
- Ordinary user could not inspect another user's effective access.
- Admin viewed audit log.
- Ordinary user with `view_audit` viewed audit log.
- Ordinary user without `view_audit` could not view audit log.
- Ordinary user created an API token.
- API token authenticated as ordinary user.
- Ordinary user deleted own API token.
- Deleted API token was rejected.
- Admin could not delete self.

## Findings

None.
