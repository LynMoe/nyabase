# Requirements

- Mode: design-only / developer handoff.
- User intent: GPU is reusable/shared rather than exclusive; produce an execution-ready design to fix state/status observation and frontend issues.
- Must cover:
  - runtime/status observation issue from prior full-system testing;
  - frontend Playwright/route/API fixture drift;
  - GPU reusable/shared semantics so developers do not implement exclusive GPU lease behavior;
  - verification plan and risk boundaries for developers.
- Non-goal: do not implement product fixes in this pass unless explicitly requested later.
