# Requirements

- Mode: implementation + release-style verification.
- User asks to complete all pending items and ensure user/admin perspectives work.
- Must fix:
  - GPU is reusable/shared, not exclusive.
  - Docker daemon/status observation persistence/readback.
  - Frontend V2 route/API fixture drift.
  - Container shell must not remain a placeholder anywhere in product UI.
- Must verify frontend/backend, admin/user perspectives, and avoid compiled artifacts under `packages/common/src/**`.
