Task: nyabase live-test environment preflight and shared-instance startup.

Scope:
- Read `test/docs/RUNBOOK.md` and `test/README.md`.
- Use the documented fixed local reset/start flow when needed.
- Register and deploy exactly the agents in `test/config/agents.json`.
- Run smoke readiness only.
- Capture runtime fingerprint details for backend, frontend, API auth, frontend HTML, VictoriaMetrics, server rows, agent online status, and remote service health.

Non-goals:
- Do not edit product files.
- Do not run full persona, redteam, mount, dropbear, or destructive functional suites in this lane.
- Do not write outside `test/runtime/**` and this harness record directory.

Execution role: lead as devops/tester subagent.
