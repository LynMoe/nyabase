# Worklog
- Added runtimeConfirmation DTO type/reason and common dist rebuilt for downstream type consumers.
- Added ContainerLifecycleEntity.runtimeConfirmation plus TypeORM migration 1780683600000.
- OperationOrchestratorService now writes 45s confirmation locks after successful runtime operations and clears on delete/failure.
- ContainerControlService computes pending/confirmed/expired from latest full state report and clears confirmed/expired locks when enqueueing the next operation.
- ContainerActionPolicyService blocks mutating actions during pending confirmation while leaving stats/console status-based; expired confirmations bypass drift blocking.
- Frontend container row/detail show 确认中/确认超时 with warning badge and pending spinner.
- Agent full state report interval changed to 15_000ms; metrics interval untouched.
- Verification: common/backend/frontend/agent typecheck passed; backend focused tests passed; common src compiled-artifact find returned empty.
- Live API suite was not run because current services/agents were not restarted/deployed in this turn and the suite performs real container operations.
