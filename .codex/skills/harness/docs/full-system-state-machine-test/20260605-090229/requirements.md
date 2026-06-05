# Requirements

- Mode: report-only / full test execution with architectural assessment.
- Risk tier: live-test + release-style verification, because user requested end-to-end system health across roles, runtime/state-machine behavior, quotas/GPU/SSH/container/image features.
- User outcome: execute the most complete local test flow available from administrator and user perspectives, cover containers, users, images, quotas, GPU, SSH, edge cases, and state-machine robustness; report test results and judge whether architecture has major defects or architecture-caused problems.
- Hard requirements:
  - Admin perspective tests.
  - User perspective tests.
  - Coverage of containers, users, images, quotas, GPU, SSH.
  - Boundary and state-machine robustness assessment.
  - Final test report with architecture defect assessment.
- Boundaries:
  - Do not silently fix product code; record findings.
  - Use local repo/runtime capabilities only unless a concrete external service is already configured.
  - Avoid destructive host operations; clean up any test resources created.
