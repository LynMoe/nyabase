# Harness Skill Iteration Requirements

## Original Request

The user asked to improve and iterate the nyabase harness skill by studying the project's historical development process, harness-produced records, and Codex conversation history. The specific pain points called out were:

- Execution took too long, possibly due to excessive splitting, unclear responsibilities, and forced decoupling.
- Human intervention was too frequent. Visual review should be performed by the model itself; humans should only confirm detailed requirements between materially different designs.
- Intake may be folded into PM instead of treated as a separate blocking gate.
- Delivered output sometimes diverged from the actual requirement.
- Multiple subagents should be launched to read conversations, documents, and other records, then synthesize process problems and improvements.

## Scope

Included:

- Analyze current harness rules, role contracts, templates, checklist, and historical session records.
- Use subagents for independent read-only analysis of session docs, conversation logs, and rule design.
- Revise the harness skill itself so the default workflow is faster, less human-blocking, and clearer about ownership.
- Preserve core engineering safeguards: session records, role accountability when useful, tests, visual evidence, review, and the `packages/common/src` artifact invariant.

Excluded:

- Product code changes outside `.codex/skills/harness/**`.
- Rewriting historical session records.
- Adding a separate external process/tooling system.

## Acceptance Criteria

1. Harness rules no longer require mandatory `CONFIRM_REQ`, `CONFIRM_DESIGN`, and `VISUAL_ACCEPTANCE` for routine tasks.
2. PM owns intake and can proceed autonomously from an unambiguous user request, asking the user only for material ambiguity or materially different design options.
3. Visual/UX validation is model-owned by default: tester/reviewer inspect screenshots and PM shows evidence, but explicit user visual acceptance is only required for subjective, brand/aesthetic, or user-requested approval gates.
4. Role splitting is risk-based rather than always one role per narrow deliverable; trivial and tightly coupled work can stay in the main agent or a single worker, while complex work may use parallel lanes.
5. Documentation requirements are capped and evidence-focused so they do not create large serial handoff artifacts.
6. Updated files are internally consistent across `SKILL.md`, `workflow.md`, `roles/pm.md`, templates, and DoD checklist.

## Evidence Sources

- Current harness skill files under `.codex/skills/harness/`.
- Historical session records under `.codex/skills/harness/docs/**`.
- Local Codex conversation/log history when available.
- Subagent reports from the parallel analysis tasks launched for this iteration.
