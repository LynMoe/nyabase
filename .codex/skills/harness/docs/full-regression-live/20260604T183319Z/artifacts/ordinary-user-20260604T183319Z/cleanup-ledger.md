# Cleanup Ledger — ordinary user lane

Run prefix: `frlive-user-20260604T183319Z-` (actual container names were lower-cased by probes).

Created resources:
- `frlive-user-20260604t183319z-alpha-cpu-mpzugakp` — container `6a253551-0c47-41c4-b957-efccd5ec0422` — created active, deleted via operation.
- `frlive-user-20260604t183319z-gamma-gpucount-mpzuklzc` — container `8f8c29d5-b5fd-4fa8-8a4a-38b86d7a12bf` — created active for GPU-count bug probe, deleted via operation.

Cleanup proof:
- `api-create-flow.json`: cleanup `deleted=true`, residuals `[]`.
- `api-gpu-count-probe.json`: cleanup `deleted=true`, residuals `[]`.
- `cleanup-prefix-proof.json`: 2 matching DB rows, 0 active rows; both matching rows have `deletedAt` set.

Residual owner / next action: none for active runtime resources created by this lane.
