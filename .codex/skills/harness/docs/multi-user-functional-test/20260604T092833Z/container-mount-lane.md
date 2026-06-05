# Container and Mount Lane

- Verdict: FAIL
- Classification: fail-product
- Target: `http://localhost:5173/api` through frontend proxy
- Command: `NYABASE_ALPHA_PASSWORD=<redacted> NYABASE_BETA_PASSWORD=<redacted> node .codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/container-mount-lane-followup.mjs`
- Counts: 33 passed / 1 failed / 0 skipped
- Evidence JSON: `/root/nyabase/.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/container-mount-lane-evidence.json`
- Raw secrets recorded: no

## Summary

Container create is generally stuck in this running environment, not limited to ordinary-user lane inputs. The container-mount lane created `cml-20260604t094055z-alpha-c1` as alpha with a local mount; it remained lifecycle `creating`/status `unknown`, operation `12bc1ed5-deb3-493a-b4d4-b08897fa86d8` stayed `queued`, and command `33aeb7f7-fe8e-4275-b330-cb79b02d503b` stayed `pending` with `attempts: 0`. A later admin-owned plain create used the same online server/image with no mounts and also remained queued/pending after 20 seconds.

## Acceptance Coverage

- AC #1: Exercised container list/detail/create validation through `/containers`: missing body, invalid name/server/image, quota overage, ungranted mount source, list, and stuck container detail via admin/owner views.
- AC #2: Lifecycle start/stop/restart/delete were exercised on the lane-created unbound container and returned controlled `409` responses because no Docker binding exists. Full live lifecycle could not complete because create operations do not dispatch.
- AC #3: Exercised local mount-source grant visibility, data-dir list/isolation/delete-denial, owner mount inspection on the stuck mounted container, and cross-user mount-list denial. Remote source was observed in admin inventory on an offline server only, so remote create/attach was limited to denial coverage.
- AC #4: Probed cross-user isolation for data dirs and mounts, plus concurrent data-dir create residue from the first lane run. Compared ordinary/alpha stuck create with admin plain create to isolate whether the stuck symptom is input-specific.
- AC #5: Findings below include reproduction, observed behavior, expected behavior, impact, and evidence paths.

## Findings

### Container create operations remain queued and never dispatch

- Reproduction: run the command above, or `POST /api/containers` as admin with server `05cea385-d6ca-490a-a126-e00d0ae23b70`, image `e6c7a01f-4431-4ac4-885e-bcf6ab755c60`, name matching `cmlcmp-*-admin`, `cpuMillis: 100`, `memBytes: 67108864`, no mounts.
- Observed: existing stuck creates before admin comparison: `[{"name":"cml-20260604t094055z-alpha-c1","containerId":"ca2f18bf-c380-4f04-a69a-e8ec079d59ed","operationId":"12bc1ed5-deb3-493a-b4d4-b08897fa86d8","operationStatus":"queued","dockerId":""},{"name":"ou20260604093841a","containerId":"5e1c4503-d766-47f4-960f-7c067a694899","operationId":"5434a702-0c4d-4660-b80c-9ea6c99dde27","operationStatus":"queued","dockerId":""},{"name":"ou20260604093841b","containerId":"ce8d4533-3d6c-477c-bd0b-1909db358933","operationId":"cf1d0d2c-2837-491d-a6c1-5abe1b579547","operationStatus":"queued","dockerId":""},{"name":"testgpu","containerId":"98646d5d-35cd-4409-a06c-402a96551a37","operationId":"6e1b85ab-3a80-4bf3-8d04-7f6e46d46c83","operationStatus":"queued","dockerId":"b0015b72befab7c99444b6b497d2bebfa620725b7dcbb88b12c1c056a76cd028"},{"name":"test","containerId":"c4c4682c-1cd1-4580-b0b5-930c0dc54f5c","operationId":"feafe504-b4e5-4fcb-ac1f-39dbe1921856","operationStatus":"queued","dockerId":"8c62593a28a82502555ff3668f8f8c58bfc798a9462147932228063c2f93566c"}]`.
- Observed admin comparison: `{"name":"cmlcmp-20260604t095421z-admin","containerId":"79bcd2fb-7308-45e4-ac7a-19ad7991d0c1","operationId":"88596d06-586e-47a6-ace9-060d398d89f3","operationStatus":"queued","dockerId":""}`.
- Expected: create operation should be dispatched to the online agent, transition out of `queued`, bind a Docker ID, and reach `succeeded` or a terminal failure with actionable error.
- Impact: container detail/lifecycle/mount attach-detach flows cannot complete for new containers; delete/start/stop/restart on the unbound desired row return `409`, leaving stuck desired containers behind.
- Evidence: `/root/nyabase/.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/container-mount-lane-evidence.json` includes operation bodies, command statuses, delete responses, and residual IDs.

## Cleanup / Residue

- No stuck containers were deleted; delete was probed once and not waited on, per PM/user instruction.
- Temporary online grants added by the interrupted lane run were revoked for alpha and beta after evidence capture.
- Two data directories remain because the interrupted run stopped before safe data-dir cleanup, and the alpha directory is referenced by the stuck desired mount. They are named with the lane prefix and should be cleaned only after the stuck desired container/mount rows are resolved.
- Remaining lane resources: `{"containers":[{"id":"79bcd2fb-7308-45e4-ac7a-19ad7991d0c1","containerId":"79bcd2fb-7308-45e4-ac7a-19ad7991d0c1","serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","name":"cmlcmp-20260604t095421z-admin","dockerId":"","status":"unknown","lifecycle":{"containerId":"79bcd2fb-7308-45e4-ac7a-19ad7991d0c1","dockerId":null,"phase":"creating","powerIntent":"running","specGeneration":1,"observedSpecGeneration":null,"stale":true,"drift":[{"kind":"runtime_missing"}]},"operation":{"id":"88596d06-586e-47a6-ace9-060d398d89f3","kind":"container.create","status":"queued","resourceType":"container","resourceId":"79bcd2fb-7308-45e4-ac7a-19ad7991d0c1","serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","attempts":0,"lastError":null,"createdAt":"2026-06-04T09:54:21.000Z","startedAt":null,"completedAt":null}},{"id":"ca2f18bf-c380-4f04-a69a-e8ec079d59ed","containerId":"ca2f18bf-c380-4f04-a69a-e8ec079d59ed","serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","name":"cml-20260604t094055z-alpha-c1","dockerId":"","status":"unknown","lifecycle":{"containerId":"ca2f18bf-c380-4f04-a69a-e8ec079d59ed","dockerId":null,"phase":"creating","powerIntent":"running","specGeneration":1,"observedSpecGeneration":null,"stale":true,"drift":[{"kind":"runtime_missing"}]},"operation":{"id":"12bc1ed5-deb3-493a-b4d4-b08897fa86d8","kind":"container.create","status":"queued","resourceType":"container","resourceId":"ca2f18bf-c380-4f04-a69a-e8ec079d59ed","serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","attempts":0,"lastError":null,"createdAt":"2026-06-04T09:44:26.000Z","startedAt":null,"completedAt":null}}],"dataDirs":[{"id":"f2497fbd-3467-4e72-9d7f-d75678db538a","userId":"fdb2a9c6-a3f5-407a-af36-b6072bd8f903","sourceKind":"local","sourceId":"f3fbabd1-03a8-49b5-8290-8c7092b700e3","name":"cml-20260604t094055z-alpha-dir","hostPath":"/data/nyabase-docker//cml-20260604t094055z-alpha-dir","serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","serverName":"nyabase-cpu-batch-20260601T163636Z"},{"id":"7bf89567-269f-445b-93fe-865b8d3c7a27","userId":"be32921a-b857-4880-9486-fd47cc04e6cd","sourceKind":"local","sourceId":"f3fbabd1-03a8-49b5-8290-8c7092b700e3","name":"cml-20260604t094055z-race","hostPath":"/data/nyabase-docker//cml-20260604t094055z-race","serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","serverName":"nyabase-cpu-batch-20260601T163636Z"}]}`.

## Handoff Credentials Used

- Used admin-lane alpha and beta throwaway credentials supplied by PM; passwords were provided via environment variables and not written to artifacts.
