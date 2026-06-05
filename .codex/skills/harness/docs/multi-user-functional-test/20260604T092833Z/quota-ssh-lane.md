# Quota and SSH Lane

## Scope

Black-box quota and SSH testing against the running nyabase system at `http://localhost:5173`, using the frontend API proxy `http://localhost:5173/api`.

Product source was not modified. Temporary lane artifacts only:

- `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/quota-ssh-lane.spec.ts`
- `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/quota-ssh-lane-evidence.json`

## Command

```bash
pnpm exec vitest run .codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/quota-ssh-lane.spec.ts --reporter=verbose
```

## Result

- Verdict: FAIL
- Counts: 5 passed / 1 failed / 0 skipped
- Root cause: product
- Failing test: `rejects invalid SSH key text for beta`
- Evidence: `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/quota-ssh-lane-evidence.json`
- Visual artifacts: n/a; black-box functional lane

## Inputs Used

Used admin-lane handoff users:

- Alpha: `admintest-20260604t093408-alpha` / `admintest-20260604t093408-A1pass!`
  - User id: `fdb2a9c6-a3f5-407a-af36-b6072bd8f903`
  - Group-level server/image grants; `view_audit`, `view_metrics_all`
- Beta: `admintest-20260604t093408-beta` / `admintest-20260604t093408-B2pass!`
  - User id: `be32921a-b857-4880-9486-fd47cc04e6cd`
  - Direct server/image grants; no management capabilities

Handoff server/image used for quota probes:

- Server: `5336594b-4f9a-4cef-b389-3ef9aa1eca78`
- Image: `59f6b47d-5b38-41b6-aff9-12193a4eeae5`

## Coverage

- AC #1: PASS with one product finding. Beta listed, added, listed again, and deleted its own valid SSH key. Beta was denied `GET`, `POST`, and `DELETE` on alpha SSH keys with `403`. Invalid key validation was independently verified and failed: `POST /users/:id/ssh-keys` accepted `keyText: "not-an-ssh-public-key"` with `201`.
- AC #2: PARTIAL. Admin read-only observation found existing running containers with SSH enabled and `sshServer.status: "running"`. Beta was denied `POST /containers/:serverId/:containerId/ssh/enable` and `/ssh/reconcile` against an admin-owned SSH container with `403`. Beta had no owned containers and the handoff server was offline, so no safe owned-container SSH enable/reconcile test was attempted. No disable endpoint is exposed by the current container controller/UI route set.
- AC #3: PASS. `/me/access` showed alpha group grant limits and beta direct grant limits. Beta CPU overrun create returned `400 CPU quota exceeded`; beta memory overrun create returned `400 Memory quota exceeded`; beta container list stayed unchanged afterward.
- AC #4: PASS with environment limitation. `/servers/:id/quota` returned runtime quota shape for alpha and beta: beta `usedBytes: 0`, `limitBytes: 134217728`; alpha `usedBytes: 0`, `limitBytes: 67108864`. `/servers/:id/disks` returned `200 []`, so no disk/pquota runtime rows were available for that offline server.
- AC #5: PASS. Reproduction steps, observed/expected behavior, impact, and evidence are below and in the evidence JSON.

## Finding

### Invalid SSH public key text is accepted and persisted

Repro:

1. Login as beta handoff user.
2. Call:

```http
POST /api/users/be32921a-b857-4880-9486-fd47cc04e6cd/ssh-keys
{
  "name": "quota-ssh-20260604094305-bogus-key",
  "keyText": "not-an-ssh-public-key"
}
```

Observed:

- API returned `201`.
- Response included key id `800edd1a-9ace-4bb3-a4d6-3f40bc38b323` and `keyText: "not-an-ssh-public-key"`.
- Follow-up list showed the bogus key was persisted.
- Test cleanup deleted the bogus key with `204`.

Expected:

- API should reject malformed SSH public key text with `400`.

Impact:

- Users can persist non-key text as SSH public keys.
- If container SSH reconciliation consumes these rows without validating/filtering them, malformed lines may be written into container `authorized_keys`. This lane could not directly verify authorized_keys impact because beta had no owned container and the handoff server was offline. Existing admin-owned SSH containers stayed read-only and were not used to test beta key reconciliation.

Root cause: product.

## Other Observations

- Existing admin-visible SSH containers:
  - `db1112fe-1c55-4314-9511-6d8510c523c2/98646d5d-35cd-4409-a06c-402a96551a37`, name `testgpu`, status `running`, SSH `running`
  - `05cea385-d6ca-490a-a126-e00d0ae23b70/c4c4682c-1cd1-4580-b0b5-930c0dc54f5c`, name `test`, status `running`, SSH `running`
- Ordinary-user lane residue was independently observed read-only:
  - `05cea385-d6ca-490a-a126-e00d0ae23b70/5e1c4503-d766-47f4-960f-7c067a694899`, name `ou20260604093841a`, phase `creating`, operation `container.create` queued
  - `db1112fe-1c55-4314-9511-6d8510c523c2/ce8d4533-3d6c-477c-bd0b-1909db358933`, name `ou20260604093841b`, phase `creating`, operation `container.create` queued
- No delete or mutation was attempted on those stuck containers.

## Cleanup

- Valid beta key label: `quota-ssh-20260604094305-beta-key`, id `6825f74a-2a56-4cea-b038-a2d7f1350632`; deleted with `204`.
- Bogus beta key label: `quota-ssh-20260604094305-bogus-key`, id `800edd1a-9ace-4bb3-a4d6-3f40bc38b323`; deleted with `204`.
- Final sanity check: beta SSH key count `0`, beta container count `0`.
- No containers were created by this lane.
