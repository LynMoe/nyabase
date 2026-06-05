---
name: nyabase-harness
description: Mandatory nyabase project boundary contract. Use in this repository to keep user requirements intact, delegate large work through subagents, verify with evidence, and exit only after requirement reconciliation.
---

# nyabase Harness

This harness is a thin boundary contract, not a workflow engine. It tells the
lead agent what must never be lost: user requirements, safe execution, evidence,
delegation on large work, and honest exit.

## Core Contract

1. **Lead owns the user boundary.** The main agent is the lead PM/integrator. It
   keeps the latest user instructions, hard requirements, explicit tests,
   persona expectations, and execution preferences intact.
2. **Large work delegates by default.** For multi-module, live, multi-persona,
   red-team, security/permission, release, or long-running tasks, the lead should
   start subagents and keep its own context focused on scope, decisions,
   integration, and exit checks.
3. **Subagents execute, not excuse.** A subagent, old plan, runbook, existing
   suite, or helper script cannot narrow the user's request. If the user asked
   for persona/subagent operation, scripts may assist but must not replace that
   persona lane.
4. **Evidence must match the claim.** Completion claims need direct evidence:
   code, tests, probes, screenshots inspected by the model, runtime proof,
   cleanup proof, or file-backed subagent reports. Transcript-only claims and
   nearby existing tests are not enough.
5. **Exit requires reconciliation.** Before every final response, compare the
   latest user instructions with the actual work. If any hard requirement is
   still actionable, continue or delegate; do not final.
6. **Safety remains hard.** Destructive/external-risk work, credentials, cost,
   subjective user choices, and live/runtime uncertainty require appropriate
   confirmation or preflight.

## Lead Exit Contract

The lead may exit only in one of these states:

- **Done:** all hard requirements are satisfied with evidence.
- **Blocked:** the remaining hard requirement cannot be advanced without missing
  credentials, unavailable infrastructure, a required user decision, or another
  concrete external condition.
- **Conflict:** user requirements conflict with each other, safety, permissions,
  or observable facts.

Not valid exit reasons:

- existing tests do not cover the request;
- a similar suite passed;
- a subagent did not cover it;
- the gap is written as residual risk;
- context is getting long;
- a plan or runbook scoped it smaller than the latest user message.

Final responses must include a concise requirement comparison when the task is
non-trivial:

```text
Requirement check:
- <requirement>: done | failed | blocked :: <evidence or reason>
```

## Delegation Policy

Use subagents more, not less, when scale or independence warrants it.

- **Small tasks:** lead may execute directly.
- **Medium tasks:** lead plus one worker/tester is usually enough.
- **Large tasks:** default to PM + subagents. Split by responsibility, persona,
  or risk domain, not by tiny files.
- **User-requested subagents:** start them unless unavailable; if unavailable,
  state that constraint.
- **Persona/red-team/live tasks:** use persona or attacker lanes when the user
  asked for user-identity behavior.
- **Independent confidence:** use reviewer/tester lanes for security, auth,
  permissions, data, release, and repeated fail/fix cycles.

Good lanes: backend/control-plane, frontend/user-flow, agent/runtime,
devops/live environment, admin persona, ordinary user persona, quota-limited
user, red-team attacker, tester, reviewer.

Bad lanes: one endpoint per agent, one file per agent, report-only analysis in
place of requested execution, or developer/tester/devops ping-pong for work one
cohesive worker can close.

Subagent reports should be short and file-backed:

```text
Goal:
Done:
Evidence:
Failed/blocked:
Changed files:
```

## Evidence And Verification

- User-requested commands, tests, probes, personas, and matrix rows are hard
  requirements unless impossible, unsafe, or explicitly excluded by the user.
- Each hard requirement ends as `done`, `failed`, or `blocked`. Use `partial`
  only as internal explanation, not as completion.
- Existing suites are evidence sources, not task scope. If they do not cover the
  requested scenario, add a bounded probe/test when safe or report failed/blocked.
- For UI changes, inspect fresh screenshots or objective render evidence before
  claiming visual correctness.
- For live/runtime claims, prove the request hit the intended backend/frontend,
  DB, service, and agent version closely enough to rule out stale runtime.
- If code/build/restart/deploy changed during the task, final live claims must
  be based on the post-change runtime.
- Runtime resources created during testing need cleanup ownership and proof, or
  an explicit cleanup-blocked reason.

## Nyabase Invariants

- Never leave generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` under
  `packages/common/src/**`. When relevant or after broad checks, run:

```bash
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
```

- Vite aliases `@nyabase/common` to `packages/common/src/index.ts`; stale
  compiled files in `src/` can shadow TypeScript sources.
- Do not overwrite unrelated user changes.
- Do not perform destructive operations without a clear user basis plus
  backup/rollback/preflight; ask if destructive scope is ambiguous.

## Documentation

Use docs to preserve evidence, not to create process work.

- Small/read-only answers: no harness docs needed.
- Non-trivial tasks: keep a short record under
  `.codex/skills/harness/docs/<requirement>/<session>/` with `requirements.md`
  and `worklog.md`.
- Large multi-lane work: add a short top-level `tests.md`, `review.md`, or
  `final-report.md` that reconciles lane reports and stale failures.
- Logs and screenshots should be artifact paths, not pasted walls of text.

## Role Files

Use these role contracts when delegating:

- `roles/pm.md` - lead PM/integrator.
- `roles/worker.md` - cohesive implementation lane.
- `roles/tester.md` - verification, persona, red-team, visual evidence.
- `roles/devops.md` - runtime, build, deploy, environment, cleanup.
- `roles/reviewer.md` - independent audit.
- `roles/architect.md` - high-risk design only.

Older role files may exist for compatibility, but the contracts above are the
preferred set.
