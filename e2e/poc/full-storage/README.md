# Full storage real-machine PoC

This directory remains a standalone feasibility probe, isolated from the shared
E2E compose/provider/spec implementation. It originally proved that a CPU-only
Docker host could run the real storage fixtures now integrated into the `full`
profile.

The probe starts:

- userspace NFS-Ganesha with a VFS export; it never starts, mounts, reloads, or
  reconfigures the host kernel `nfsd`;
- one real Ceph Squid cluster containing one monitor, one manager, one BlueStore
  OSD backed by an exactly-owned loop device, and one active MDS;
- two independent privileged client containers. Each uses the host kernel NFS
  and Ceph filesystem clients to mount both servers concurrently.

Both clients write and read each other's data on NFS and CephFS. The probe then
performs normal (non-lazy, non-forced) unmounts of all four mountpoints and proves
that they disappeared. Its EXIT trap stops only run-labelled containers, detaches
only the recorded loop device, removes its isolated network and run images, and
audits zero container/network/volume/image/loop residue.

## Run

Run as root from any directory:

```bash
sudo e2e/poc/full-storage/run.sh
```

Useful bounded overrides:

```bash
sudo POC_RUN_ID=storage-poc-manual \
  POC_SUBNET=172.31.252.0/24 \
  POC_OSD_SIZE_GIB=6 \
  e2e/poc/full-storage/run.sh
```

The host needs Docker with privileged-container support, at least two CPU cores,
6 GiB available RAM, 8 GiB free disk space, a free loop device, and kernel modules
matching the running kernel. The script rejects an overlapping `/24` and refuses
to touch stale resources owned by another PoC run.

The only retained artifact is a secret-free, mode `0600` evidence file under
`/tmp/nyabase-full-storage-poc-evidence/`. Cephx material is created only beneath
the mode `0700` private runtime directory, every key/secret file is checked as
mode `0600`, no secret value is passed on a command line or printed, and the
runtime directory and BlueStore backing file are deleted during cleanup.

The official Ceph base is pinned to Ceph Squid `19.2.3` by digest. Debian
`trixie-slim` supplies NFS-Ganesha `6.5`; `bookworm-slim` supplies the two
kernel-mount clients. No GPU device, runtime, or Docker GPU request is used.

## Scope of this PoC

Proved here: fixture feasibility, real kernel mounts, shared storage semantics,
two-node/client visibility, normal unmount, secret handling, host-nfsd isolation,
and deterministic resource cleanup.

This standalone probe does not exercise Nyabase API/UI workflows, assignment
reconciliation, busy-unmount behavior, or recovery. Those product paths and the
provider-owned NFS/CephFS fixtures are covered by the layered `full` and
`recovery` profiles; this directory is retained only as a focused infrastructure
diagnostic.
