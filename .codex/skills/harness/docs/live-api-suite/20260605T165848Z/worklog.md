# Worklog

- Added test/scripts/run-live-api-suite.mjs as the real API orchestrator.
- Deleted test/scripts/run-functional.sh.
- Rewrote test/scripts/run-live-suite.sh to route api/all/full and compatibility names to the new live API suite; legacy red-team specs remain explicit legacy entries.
- Updated package.json test:functional to run the new API suite.
- Updated test README/runbook and old control-plane docs to point at the new flow.
- Smoke passed: test/runtime/live-api/runs/20260605t165327-3311b1/report.json.
- Full live API suite passed: test/runtime/live-api/runs/20260605t165848-b53d9a/report.json, pass=11 fail=0 blocked=0.
- Cleanup proof: admin/v2/containers query for live-api-* returned [].
- common/src artifact guard returned no output.
