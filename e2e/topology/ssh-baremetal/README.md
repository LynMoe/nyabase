# SSH bare-metal topology (future contract)

`ssh-baremetal` is an extension point, not an implemented provider. There is no
provider module, host inventory, credential flow, lifecycle entrypoint, or live
evidence for it in this repository today. Do not select it or report bare-metal
coverage until all conditions below are met.

An implementation must satisfy `TopologyProvider` from `../provider.ts` and:

1. remain `implementation: "future"` with `lifecycle: null` until every
   lifecycle phase (`doctor`, `build`, `up`, `health`, `diagnose`, and `down`)
   has a real, bounded entrypoint;
2. classify every capability explicitly. Planned capabilities are not
   available, and `requireTopologyCapabilities` must turn a missing capability
   into `BLOCKED` rather than a skip;
3. lease at least two dedicated CPU hosts per run, prove ownership before any
   mutation, and record every process, mount, address, and service in a
   run-scoped manifest;
4. keep SSH credentials and generated product secrets out of logs and test
   artifacts, and make cleanup safe to retry after partial failure;
5. expose topology actions through the provider boundary. Specs must not issue
   ad-hoc SSH, Docker, systemd, mount, or network commands;
6. run the same product specs as Docker-DinD, with provider-specific assertions
   confined to `00-foundation`.

Physical-host capability claims need fresh evidence from the selected hosts.
In particular, `physical-nic`, `physical-switch`, `bare-metal-boot`, and
`kernel-matrix` cannot be inherited from Docker-DinD results. Switch/NIC claims
also require an owned test network and explicit VLAN, MTU, and port-security
preflight. Missing host access, safe isolation, or cleanup authority is a hard
`BLOCKED` result.
