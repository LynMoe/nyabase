# Requirements
- Add lightweight runtime confirmation lock on container_lifecycle.
- Write confirmation after successful create/start/stop/restart/updateMounts/SSH operations; skip delete.
- Pending lock blocks mutating operations but keeps stats/console based on runtime status.
- Expired lock does not block retry/remediation.
- Surface pending/expired confirmation in list/detail UI.
- Reduce agent full state report interval from 60s to 15s.
- Verify typechecks/tests and common src artifact invariant.
