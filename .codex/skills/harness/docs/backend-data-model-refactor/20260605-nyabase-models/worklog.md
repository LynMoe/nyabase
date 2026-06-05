# Worklog

- Intake: high-risk backend entity/migration refactor requested; no live specs modification.
- Plan: inspect redesign docs/current entities/usages, edit entities + DB registry + migration, run backend typecheck, adapt minimal breakages.
- Implemented: split control/spec/lifecycle/runtime/GPU/orphan entities; registered in DB_ENTITIES; added additive migration that rebuilds containers and creates new tables.
- Typecheck initially failed due old services/tests compiling against removed ContainerEntity fields. Added undecorated transitional type-only declarations on ContainerEntity so old code compiles without reintroducing DB columns.
- Verification: `pnpm --filter @nyabase/backend typecheck` passed. Common source artifact guard passed with no output.
