# Test Report Sketch

Tester reports should be short and file-backed.

```text
Goal:
Verdict: PASS | FAIL | BLOCKED
Suites/probes:
  - <command/probe> -> pass|fail|skipped (<reason>)
Requirement results:
  - <requirement>: done|failed|blocked :: <evidence/reason>
Failures:
  - <case> :: <classification> :: <evidence>
Artifacts:
  - <path>
Open risks:
  - <risk or none>
```

`PASS` means every assigned hard requirement is done with direct evidence. A
skipped user-requested test/probe/persona is `FAIL` or `BLOCKED`, not residual
risk.
