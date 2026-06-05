# Requirements — Container Control Plane V2 Cutover

- Role: developer subagent product/test implementation lane.
- Risk: high-risk + live-test (API/protocol/data/frontend/live tests).
- Objective: hard incompatible V2 cutover per docs/container-control-plane-redesign.md.
- No old public route identity `{serverId, containerId}`; public identity only `containerId`.
- No public/test/frontend canonical Docker ID or `spec.dockerId`.
- All container mutations return operation refs and are polled.
- Frontend consumes backend `ContainerView.actions`; no business inference.
- DB preservation not required; reset schema/migrations if useful.
- Remove/rewrite old lifecycle/read-model/reconcile hooks, no hidden fallback.
- Strengthen conformance checks against known residues.
- Keep generated artifacts out of `packages/common/src/**`.
