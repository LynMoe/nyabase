# Requirements

- Role: backend data model sub-agent.
- Scope: `/root/nyabase`, primarily:
  - `packages/backend/src/entities`
  - `packages/backend/src/database/db-entities.ts`
  - `packages/backend/src/database/migrations`
- Move toward `docs/container-control-plane-redesign.md` new table structure.
- Do not retain old container runtime as business identity.
- Add/split entities:
  - `container_desired_specs`
  - `container_lifecycle`
  - `runtime_containers`
  - `runtime_container_stats`
  - `runtime_gpu_inventory`
  - `gpu_allocations`
  - `runtime_orphans`
- Adjust `ContainerEntity`: remove mixed runtime fields like `dockerId` / `lifecyclePhase`; keep core control-state fields.
- Do not modify live specs.
- Keep backend typecheck passing where possible; make minimal old-service adaptations or report blockers.
- Run `pnpm --filter @nyabase/backend typecheck` and report changed files/results.

Classification: high-risk data/schema refactor. Execution mode: lead as implementer with focused typecheck; lead self-review.
