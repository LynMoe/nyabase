# Requirements

User intent: implement container creation quota flow where CPU, memory, and GPU are no longer client-submitted resources.

Hard requirements:
- Remove cpuMillis, memBytes, gpuIndices, and gpuCount from CreateContainerRequest schema.
- Container create uses the resolved server grant as per-container CPU and memory limits.
- CPU and memory are not aggregate user quotas during create.
- Disk remains aggregate/shared by user on the server.
- GPU assignment is automatic from the resolved grant: none -> [], indices -> all grant indices, all -> all known server GPU indices.
- Admin/default grant UI stays unchanged.
- Frontend create dialog no longer exposes or submits CPU, memory, or GPU quantity fields.
- Run focused common/backend/frontend checks and common src artifact guard.

Execution: lead as implementer.
