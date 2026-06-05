# Thin Harness Rewrite

## User Request

Refactor the nyabase harness so the overall rules are minimal, directional, and
boundary-focused rather than a runtime state system. Preserve a strong PM role:
for large work the main agent should delegate implementation/testing to
subagents to avoid context exhaustion, while the main agent owns user
requirements and may only exit after comparing work against the latest user
instructions.

## Hard Requirements

- Rules should be as few as possible and act as boundaries/direction.
- Avoid runtime-state/process-engine style rules.
- For large-scale requirements, default to lead PM + subagents.
- Main agent must clearly maintain user requirement boundaries.
- Each final exit must compare current work against user instructions.
- The lead may exit only when all hard requirements are satisfied, truly
  blocked, or conflicting with another user/safety/factual constraint.
- Preserve nyabase invariants such as no generated artifacts under
  `packages/common/src/**`.

## Boundaries

- Harness files only.
- No product code changes.
- Keep compatibility for old role/template references where cheap, but make the
  main rules thin.
