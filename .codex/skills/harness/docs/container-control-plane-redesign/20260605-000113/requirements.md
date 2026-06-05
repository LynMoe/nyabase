# Requirements

User objective: write a design document that lets developers complete a one-shot incompatible refactor. The old container/control/runtime/operation chain must be fully removed; compatibility is not required; database data may be discarded. After implementation, tests and regression must prove the implementation exactly matches the design.

Mode: architecture/design for high-risk implementation and future test/regression.
Risk tier: high-risk + live-test because it changes public API/protocol, DB schema, container lifecycle, agent protocol, frontend behavior, and live runtime tests.

Hard requirements:
- Produce a concrete design doc suitable for direct developer implementation.
- Explicitly require full removal of old chain and no compatibility layer.
- Include DB reset/new schema strategy; no data preservation needed.
- Include API, backend, agent, frontend, test, live cleanup, and regression plan.
- Include design-conformance verification so tests prove implementation matches the document.
- Preserve invariant: no generated artifacts under packages/common/src.

Current turn scope:
- Create the authoritative design document and harness record.
- Do not claim the full implementation/regression is complete until code is implemented and verified.
