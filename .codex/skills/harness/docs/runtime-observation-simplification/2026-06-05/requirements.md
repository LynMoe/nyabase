# Runtime Observation Simplification

- Remove DB runtime/observation read model tables/entities/services from backend production code.
- Make `StateCache` the only runtime read model and add runtime readiness gates.
- Keep runtime operations blocked until first full state report marks a server ready.
- Update container/server/datadir/remote-fs/metrics reads to avoid runtime observation DB fallbacks.
- Verify removal searches and `packages/common/src` generated-artifact invariant.

