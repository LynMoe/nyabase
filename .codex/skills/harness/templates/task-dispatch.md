# Task Dispatch Sketch

Use only the fields that help the subagent execute. Keep dispatches short.

```markdown
## Lane
<worker | tester | devops | reviewer | architect>

## Goal
<one concrete outcome>

## User Boundary
<hard requirements / source phrase / non-goals relevant to this lane>

## Scope
Allowed writes: <paths or "none">
Forbidden: <constraints>

## Evidence Expected
<tests/probes/artifacts/report paths>

## Claims Not Allowed
<what this lane must not claim as covered>

## Output
Goal / Done / Evidence / Failed or blocked / Changed files
```

Do not dispatch tiny file-sized lanes. For large tasks, dispatch broad lanes by
responsibility, persona, or risk domain.
