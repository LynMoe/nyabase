# Requirements

User requested: run full test workflow with multiple subagents from admin and user sides. Admin creates users/images/etc; user performs container operations. After completion, build a test report and start architecture/development repair.

Mode: test-and-fix + live-test.
Risk tier: live-test / high-risk because it touches runtime services, auth/admin/user workflows, container lifecycle, and cross-package behavior.

Hard requirements:
- Use multiple subagents.
- Cover admin-side workflow.
- Cover user-side workflow.
- Produce test report.
- Start architecture/development fixes for discovered issues.

Guardrails:
- Preserve no compiled artifacts under packages/common/src.
- Record runtime/resource evidence and cleanup where applicable.
