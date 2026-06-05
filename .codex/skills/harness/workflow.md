# Harness Playbook

This file is guidance. The binding contract is `SKILL.md`.

## Fast Path

- If the task is small and clear, the lead may execute directly.
- If the task is a question or report-only review, answer with findings and do
  not create process docs unless useful.
- If the task is large, live, multi-module, multi-persona, red-team,
  security/permission, or release-like, start subagents early and keep the lead
  focused on PM/integration.

## Large Work Pattern

1. **Boundary:** capture the latest user hard requirements, explicit tests,
   personas, non-goals, and execution preferences.
2. **Dispatch:** split by responsibility, persona, or risk domain. Prefer broad
   lanes that can produce evidence independently.
3. **Integrate:** read short lane reports first; open detailed artifacts only
   for conflicts, failures, and acceptance evidence.
4. **Close gaps:** compare lane output to the user boundary. If a hard
   requirement is still actionable, continue or dispatch another lane.
5. **Exit:** final only when all hard requirements are done, failed after
   attempted evidence, blocked, or conflicting.

This is the recommended shape for keeping large tasks moving without filling the
lead context; adapt it to the work instead of treating it as a process gate.

## User Decisions

Ask the user only for material ambiguity, destructive or external-risk actions,
credentials/cost, subjective product/design choices, or explicit approval
requests. If the user said not to ask, proceed unless one of those triggers
applies.

## Verification Direction

- Match checks to risk and user claims.
- A passing existing suite supports only what it actually covers.
- UI claims need fresh render evidence when visual correctness matters.
- Live/runtime claims need proof that the current process, DB, frontend, service,
  and agents are the ones under test.
- Code/build/restart/deploy changes invalidate earlier runtime proof.
- Created runtime resources need cleanup proof or a named cleanup blocker.

## Failure Labels

Use plain labels only when they clarify routing: `product-bug`, `test-bug`,
`env-drift`, `stale-build`, `needs-runtime-deploy`, `infra`,
`cleanup-blocked`, `infra-precondition`, `convergence-timeout`, or
`unclear-spec`.

Do not classify live behavior as product failure until wrong runtime, stale
build/binary, wrong DB/port, token mismatch, and offline agents are reasonably
ruled out.
