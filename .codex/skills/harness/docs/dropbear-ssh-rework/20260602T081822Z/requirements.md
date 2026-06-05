# Requirements: Dropbear SSH Rework

## Original Request

User wants the nyabase container SSH system redesigned and implemented through the harness workflow:

- Fully remove the existing SSH path.
- Rebuild around a statically compiled Dropbear bundled with the agent.
- Users manage public keys in the user center.
- Container creation UI lets users choose whether to enable the Dropbear SSH server.
- Containers created with SSH disabled can enable Dropbear SSH later.
- SSH enablement is one-way: once enabled, nyabase must not expose an API/UI path to disable it.
- Users need a manual per-container SSH reconcile action/button to repair SSH state, for example after the in-container Dropbear/sshd process is accidentally killed.
- When enabled, after container creation/start the agent copies Dropbear into the container and starts it in the background.
- Password login is forbidden; public key login is required.
- On every container start, root authorized keys must be reconciled.
- Public keys must update in real time across all affected containers after user add/delete operations.
- Support port forwarding, agent forwarding, and similar SSH features as openly as practical.
- Design the full lifecycle and edge cases for maintainability.

## Current Code Findings

- Existing SSH fields are spread across protocol and container state:
  - `packages/common/src/protocol/rest-schema.ts`: `sshUser`, `sshUid`.
  - `packages/common/src/protocol/agent-messages.ts`: `sshUser`, `sshUid`, `sshPubKeys`.
  - `packages/common/src/constants.ts`: Docker labels `SSH_USER`, `SSH_UID`.
- Backend currently fetches user SSH keys during container creation and sends them only in the create RPC:
  - `packages/backend/src/containers/containers.service.ts`.
- Agent currently injects keys into `/home/<sshUser>/.ssh/authorized_keys` via container exec:
  - `packages/agent/src/commands/dispatcher.ts`.
- User SSH key CRUD already exists:
  - `packages/backend/src/users/users.controller.ts`.
  - `packages/backend/src/users/users.service.ts`.
  - `packages/backend/src/entities/ssh-public-key.entity.ts`.
- Container lifecycle hooks exist and can support reconciliation:
  - `AgentGateway.registerOnStateReport`.
  - `AgentGateway.registerOnContainerStart`.
  - Container start/restart service methods.
- Frontend currently references SSH user/UID in container detail and says SSH keys are auto-injected in create dialog.

## Requirement Summary Draft

### Goal

Replace the current one-shot SSH key injection flow with a maintainable Dropbear-based SSH subsystem that is opt-in per container, public-key-only, lifecycle-aware, and supports forwarding features by default.

### In Scope

- Remove legacy container SSH fields/behavior where they only exist for SSH key injection:
  - `sshPubKeys` in create-container RPC.
  - `sshUid` as a REST/RPC/state/label/frontend SSH field.
  - agent `injectSshKeys`.
  - `/home/<sshUser>/.ssh/authorized_keys` injection behavior.
  - frontend display/copy that implies legacy SSH user login.
- Introduce a new explicit SSH server enable flag, likely `sshServerEnabled`.
- Add protocol/API/state shape for the new SSH server lifecycle.
- Add a post-create SSH enable operation. It may transition a container from disabled to enabled, but there is no disable operation.
- Add a manual per-container SSH reconcile operation. It should be available for SSH-enabled containers and should re-ensure keys, binary, permissions, and Dropbear process state.
- Add backend key synchronization service triggered by user SSH key add/delete and lifecycle events.
- Add agent Dropbear manager:
  - copy static Dropbear binary into the container;
  - write `/root/.ssh/authorized_keys`;
  - ensure permissions accepted by Dropbear;
  - start Dropbear in the background;
  - reconcile on create/start/restart/agent reconnect/state report.
- Keep password login disabled.
- Keep Dropbear forwarding features open by default:
  - do not use `-j` / `-k`;
  - do not add `no-port-forwarding`, `no-agent-forwarding`, or restrictive authorized_keys options;
  - use `-a` if accepted by the selected Dropbear build to allow remote hosts to connect to forwarded ports.
- Update frontend creation and detail views:
  - opt-in control near image/container creation;
  - display `root@<ip>` only when Dropbear SSH is enabled;
  - remove legacy SSH user/UID wording from SSH access UX.
- Add focused tests for protocol validation, backend synchronization, agent Dropbear lifecycle, and frontend form payload/display where practical.

### Out of Scope

- Building or downloading the Dropbear binary as part of this task, unless the repository already has a convention for bundling native agent assets.
- Internet exposure, firewall/NAT management, or host-level port publishing beyond the existing container IP network path.
- Per-key restrictions or policy controls for forwarding; the requested default is open.
- Forced commands, SFTP subsystem, PAM/password login, or host user account provisioning outside what Dropbear needs for root public-key login.

### Assumptions

- Dropbear login is root-scoped: `/root/.ssh/authorized_keys`, connection hint `ssh root@<container-ip>`.
- Root login is enabled for every container where the new SSH server option is enabled.
- Existing `sshUser`/`sshUid` semantics should not survive as "SSH" concepts.
- `sshUid` should be removed entirely. The current non-SSH behavior tied to it must migrate to image configuration: when create-container creates data directories, backend/agent should use the selected image's configured UID (currently `image.defaultUid`) under a non-SSH payload/contract name, without accepting a per-container `sshUid` override.
- Backend database remains the source of truth for user public keys. Containers hold a reconciled runtime copy only.
- SSH enablement state must survive backend/agent restarts and container restarts. Since it can change after creation, the design must define how the backend/agent persists a disabled -> enabled transition for an existing Docker container.
- Existing SSH sessions may continue after a key is deleted; deletion only needs to prevent new logins.
- The static Dropbear binary should live under the agent package and may be downloaded as an already-built artifact rather than built in this task.
- Dropbear feature availability depends on the compiled binary. The agent should self-check/version-check enough to fail clearly if the bundled binary lacks required features.

### Draft Acceptance Criteria

1. Creating a container with SSH disabled does not copy/start Dropbear and does not inject any SSH keys.
2. Creating a container with SSH enabled starts Dropbear public-key-only, writes root authorized_keys from the user center keys, and allows SSH login as `root`.
3. Password login is disabled for Dropbear-managed containers.
4. Local/remote port forwarding and ssh-agent forwarding are not disabled by nyabase config or authorized_keys restrictions.
5. Adding or deleting a public key in the user center reconciles all running SSH-enabled containers owned by that user without requiring container restart.
6. Starting/restarting a stopped SSH-enabled container reconciles keys before/while ensuring Dropbear is running.
7. Agent reconnect/full state report reconciles all SSH-enabled containers on that server.
8. Legacy SSH key injection into `/home/<sshUser>/.ssh/authorized_keys` is removed.
9. Frontend no longer presents legacy SSH user/UID access as the Dropbear SSH endpoint.
10. Deleting a key does not need to terminate already-established SSH sessions.
11. `sshUid` is removed from REST create request, agent create payload, Docker labels/state, tests, and frontend display.
12. Data directories created during container creation are owned using the selected image UID through a non-SSH contract.
13. A container created with SSH disabled can later enable Dropbear SSH.
14. Once SSH is enabled for a container, nyabase exposes no API/UI path to disable it.
15. Users can manually reconcile an SSH-enabled container to restore Dropbear after accidental in-container process termination.
16. Manual reconcile is not a disable/toggle action and does not enable SSH for disabled containers unless the design explicitly combines it with the one-way enable action.
17. `bash scripts/check.sh` passes, with no generated artifacts under `packages/common/src/**`.
18. Because frontend rendered output changes, `bash scripts/check-visual.sh` passes and fresh screenshots are shown for user visual acceptance before review.

### Risks / Open Questions

- Where exactly inside `packages/agent` the static Dropbear binary/artifact metadata should live and how packaging should include it.
- Whether `sshUser` should also be fully removed or retained only if another non-SSH image user feature still needs it; it must not remain in SSH UX/Dropbear flow.
- How to persist post-create one-way SSH enablement for containers that were originally created with SSH disabled.

## References Checked

- Dropbear official page: https://dropbear.nl/mirror/dropbear.html
  - Notes OpenSSH-compatible authorized_keys, X11 forwarding, and authentication-agent forwarding.
- Debian Dropbear manpage: https://manpages.debian.org/testing/dropbear-bin/dropbear.8.en.html
  - Documents `-s` password-login disable, `-j`/`-k` forwarding disable flags, `-a` remote forwarded port exposure, and authorized_keys permission requirements.

## Requirement Delta: Dropbear Build Dockerfile

After reviewer identified the missing bundled binary as the only remaining blocker, the user requested:

- Add a Dockerfile in an appropriate repository location to produce the Dropbear binary.

Updated scope:

- The repository should contain a maintainable Docker-based build path for the Linux x64 Dropbear artifact.
- The build path should produce `nyabase-dropbear-linux-x64` plus a `.sha256` sidecar suitable for agent source-mode runtime and standalone agent packaging.
- The Dockerfile should use an official Dropbear source release rather than an untrusted third-party prebuilt binary.
- `scripts/build-agent-binary.sh` should be able to consume the generated artifact without requiring an external `NYABASE_DROPBEAR_PATH` override in the normal repository workflow.
