# Implementation: Dropbear SSH Rework

## Files Changed

- `packages/common/src/constants.ts`
- `packages/common/src/index.ts`
- `packages/common/src/protocol/agent-messages.ts`
- `packages/common/src/protocol/rest-schema.ts`
- `packages/common/src/protocol/rest.ts`
- `packages/common/src/protocol/ws.ts`
- `packages/backend/src/entities/container-ssh-enable.entity.ts`
- `packages/backend/src/database/db-entities.ts`
- `packages/backend/src/database/migrations/1780388302000-ContainerSshEnablements.ts`
- `packages/backend/src/containers/container-ssh-enablements.service.ts`
- `packages/backend/src/containers/container-ssh-sync.service.ts`
- `packages/backend/src/containers/containers.controller.ts`
- `packages/backend/src/containers/containers.module.ts`
- `packages/backend/src/containers/containers.service.ts`
- `packages/backend/src/users/users.service.ts`
- `packages/agent/src/app.ts`
- `packages/agent/src/commands/dispatcher.ts`
- `packages/agent/src/docker/docker-client.ts`
- `packages/agent/src/dropbear/dropbear-embed.ts`
- `packages/agent/src/dropbear/dropbear-manager.ts`
- `packages/frontend/src/components/containers/create-container-dialog.tsx`
- `packages/frontend/src/pages/container-detail-page.tsx`
- `packages/agent/assets/dropbear/Dockerfile`
- `packages/agent/assets/dropbear/README.md`
- `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64`
- `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64.sha256`
- `scripts/check.sh`
- `scripts/build-agent-binary.sh`

## Acceptance Criteria Mapping

- AC 1-2: Removed legacy SSH user/UID/key create payload fields, Docker label constants/parsing/writes, frontend display, and agent `/home/<sshUser>/.ssh/authorized_keys` injection path.
- AC 3-5: Create flow now sends `sshServerEnabled`, maps `createDirs[].ownerUid` from `image.defaultUid`, creates durable enablement rows for SSH-enabled creates, and performs strict post-create reconcile.
- AC 6-10: Added idempotent one-way `POST /containers/:serverId/:dockerId/ssh/enable`; stopped/offline/running behaviors match the design and no disable route/RPC/UI was added.
- AC 11-12: Missing/v1 labels parse as disabled, new labels use `nyabase.ssh_server_enabled`, spec version is `2`, and backend overlays DB enablement onto raw agent snapshots.
- AC 13-17: Added manual `POST /containers/:serverId/:dockerId/ssh/reconcile` with disabled-container conflict, stopped/offline statuses, and running-container agent repair.
- AC 18-19: Dropbear manager starts root SSH on port 22 with `-s`, omits `-j`/`-k` and restrictive key options, and uses `-a` when the bundled binary advertises it.
- AC 20-23: User key add/delete, container start events, and full state reports trigger backend reconciliation for running SSH-enabled containers.
- AC 24-25: Agent Dropbear reconcile is per-container serialized, hashes/copies the binary idempotently, avoids restart for key-only sync, restarts after binary update or missing process, and reports runtime SSH status/error fields.
- AC 26: SSH-enabled create cleans up container, expected mounts, and enablement row on strict Dropbear setup failure.
- AC 27-28: Product source supports the required test/visual cases, but tests and Playwright coverage were intentionally not edited in this developer dispatch.
- AC 29: Common source artifact guard was checked with `find`; full `scripts/check.sh` is deferred because this role may not run tests/builds.
- Follow-up AC 1-2: `packages/common/src/index.ts` now explicitly exports the agent message schema/types barrel so `@nyabase/common` exposes the Dropbear SSH snapshot and reconcile payload surface. `scripts/check.sh` now builds `@nyabase/common` after the source artifact guard and before workspace typecheck so backend/agent typechecks consume declarations regenerated from the current common source contract.
- Reviewer FAIL fix AC 1-3, 6: strict create-time SSH reconcile no longer requires the just-created container to already be present in `stateCache`; when the cache is stale during strict forced reconcile, `ContainerSshSyncService` derives the owner context from the durable enablement row created immediately before reconcile, fetches current DB public keys, and sends `reconcileContainerSsh` directly to the online agent. Non-strict lifecycle, key-change, start, manual, and full-state reconciliation still use state cache to determine running/effective targets.
- Reviewer FAIL fix AC 4: source-mode Dropbear resolution no longer silently returns an absent default path. Missing source assets become an explicit self-check/reconcile failure that tells operators to set `NYABASE_DROPBEAR_PATH` or provide the expected vendored asset, while pkg-embedded extraction remains supported. `scripts/build-agent-binary.sh` now accepts `NYABASE_DROPBEAR_PATH` / `NYABASE_DROPBEAR_SHA256_PATH`, verifies the sha256 sidecar before embedding, and still supports a vendored asset if one is intentionally supplied.
- Follow-up worker AC 27-31: `packages/agent/assets/dropbear/Dockerfile` now archives the reproducible Docker build next to the asset output. It downloads official Dropbear source release `2026.91` from `https://matt.ucc.asn.au/dropbear/releases/dropbear-2026.91.tar.bz2`, verifies the pinned source tarball SHA256 `defa924475abf6bc1e74abc00173e46bfdc804bd47caafa14f5a4ef0cc76da34` from the official `SHA256SUM.asc`, builds a static musl-linked Linux x64 `dropbear` server, and exports `nyabase-dropbear-linux-x64` plus `nyabase-dropbear-linux-x64.sha256`.
- Follow-up worker AC 30, 34: the generated default asset is present at `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64` with sidecar hash `f14a199e4aaed06c7ca2fa613c718a2156b459b8d0b405a6af4941a6d8162547`; `scripts/build-agent-binary.sh` successfully consumed it without `NYABASE_DROPBEAR_PATH` and produced `dist/nyabase-agent`.

## Notable Decisions

- The backend uses `container_ssh_enablements` rows as the durable one-way source and opportunistically backfills rows when a new v2 enabled Docker label is seen in list/detail overlay.
- Backend reconciliation is serialized per `serverId:dockerId`; the agent also uses the existing per-container mutex for file/process repair.
- The agent resolves Dropbear from `NYABASE_DROPBEAR_PATH`, pkg-embedded `nyabase-dropbear`, or an explicitly present source asset path `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64`; absent source assets are reported as a configuration failure instead of a fake usable path.
- The supplied Dropbear binary and `.sha256` sidecar are required by `scripts/build-agent-binary.sh`; the script verifies the sidecar hash and does not build, download, or cross-compile Dropbear. The source-build Dockerfile for regenerating the asset is archived in `packages/agent/assets/dropbear/Dockerfile`.
- Dropbear source provenance is fixed to official release `2026.91` with tarball URL `https://matt.ucc.asn.au/dropbear/releases/dropbear-2026.91.tar.bz2`; source integrity is enforced by the pinned official SHA256 before compilation.
- Backend and agent package tsconfigs currently point `@nyabase/common` at `../common/dist/index`; the hard gate now refreshes that generated declaration surface before running downstream typechecks instead of relying on stale `dist` output.

## Risks / Follow-Up

- The trusted Dropbear binary asset files are now present and verified. Source-mode runtime and standalone packaging no longer depend on an external `NYABASE_DROPBEAR_PATH` override for the normal Linux x64 workflow.
- Runtime repair assumes `/bin/sh`, `sha256sum`, and ordinary root filesystem paths inside the container. Minimal images without those tools may report SSH errors.
- Production migration is added, but migration execution is not performed here.

## Visual Impact

- `packages/frontend/src/components/containers/create-container-dialog.tsx`: advanced options now include an opt-in Dropbear SSH checkbox and no longer show legacy key-injection wording.
- `packages/frontend/src/pages/container-detail-page.tsx`: overview removes SSH user/UID rows, adds SSH access/status/enable/repair UI, and the browser console toolbar now shows container IP instead of a legacy SSH user hint.
