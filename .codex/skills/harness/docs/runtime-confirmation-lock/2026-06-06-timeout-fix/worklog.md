# Worklog
- Removed the attempted per-operation backend reconcile/full-report trigger from AgentCommandOutboxWorkerService.
- Added backend receive-time fields to StateCache: lastFullReportReceivedAt and lastIncrementalReportReceivedAt.
- Runtime confirmation freshness now uses backend full-report receive time, not agent observedAt, avoiding agent/backend clock skew and report collection-time skew.
- Runtime confirmation now checks whether the lock is confirmed before checking deadline expiration, so old locks that have already been observed do not keep showing as expired.
- Added a focused regression test for the receive-time confirmation path.
- Verified source still has agent full state report interval set to 15_000ms and no per-operation report trigger in outbox worker.
- Ran root typecheck and focused backend tests successfully.
- Live observation: connected test agents still emit full state reports around 60s apart, so existing deployed agents must be restarted/redeployed to pick up the 15s interval; otherwise 45s locks can still temporarily expire before the next full report.
