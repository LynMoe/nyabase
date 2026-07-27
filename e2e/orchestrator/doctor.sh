#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

run_id="$(resolve_run_id "${1:-doctor-probe}")"
probe="nyabase-e2e-${run_id}-doctor"
doctor_slot_lock=""

cleanup() {
  docker rm -f "$probe" >/dev/null 2>&1 || true
  if [[ -n "$doctor_slot_lock" ]]; then
    release_slot_lock "$run_id" "$doctor_slot_lock" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM HUP

[[ "$(uname -s)" == Linux ]] || die "trusted Linux host is required"
for command in docker openssl curl findmnt flock losetup mkfs.xfs xfs_quota sha256sum node git pnpm ss pgrep; do
  command -v "$command" >/dev/null || die "missing host command: $command"
done
docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is unavailable"
[[ "$(findmnt -n -o FSTYPE /sys/fs/cgroup)" == cgroup2 ]] || die "cgroup v2 is required"
grep -qw xfs /proc/filesystems || die "kernel XFS support is required"
[[ "$(df -Pk "$E2E_ROOT" | awk 'NR==2 {print $4}')" -ge 12582912 ]] \
  || die "at least 12 GiB free workspace space is required"

if [[ "${NYABASE_E2E_PROFILE:-smoke}" == full ]]; then
  command -v modinfo >/dev/null 2>&1 || die 'missing host command: modinfo'
  [[ -e /dev/loop-control ]] || die '/dev/loop-control is required by the Full CephFS fixture'
  losetup --find >/dev/null 2>&1 || die 'no free loop device is available for the Full CephFS fixture'
  modinfo ceph >/dev/null 2>&1 \
    || die "the Ceph client module is unavailable for kernel $(uname -r)"
  [[ "$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)" -ge 6291456 ]] \
    || die 'the Full profile requires at least 6 GiB available memory'
fi

reserve_slot_for_run "$run_id" \
  || die "no collision-free E2E slot (subnet plus three TLS ports) is available"
doctor_slot_lock="$RESERVED_SLOT_LOCK"

if ! (
  cd "$E2E_ROOT/e2e"
  node --input-type=module -e \
    "import { chromium } from '@playwright/test'; const browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.goto('about:blank'); await browser.close();"
) >/dev/null 2>&1; then
  die "Playwright Chromium is unavailable (BLOCKED); run: pnpm --filter @nyabase/e2e exec playwright install chromium"
fi

docker run -d --name "$probe" \
  --label "io.nyabase.e2e.run-id=$run_id" \
  --privileged --cgroupns=private --tmpfs /probe \
  alpine:latest sh -c 'trap : TERM INT; sleep 300 & wait' >/dev/null
docker exec "$probe" sh -ec '
  test -r /sys/fs/cgroup/cgroup.controllers
  mkdir -p /probe/mnt
  mount -t tmpfs none /probe/mnt
  touch /probe/mnt/write-proof
  umount /probe/mnt
'

cleanup
[[ ! -d "$doctor_slot_lock" ]] || die "doctor leaked E2E slot lock: $doctor_slot_lock"
trap - EXIT INT TERM HUP
doctor_slot_lock=""
[[ -z "$(docker ps -aq --filter "label=io.nyabase.e2e.run-id=$run_id")" ]] \
  || die "doctor leaked a Docker container"
log "doctor PASS: Docker privilege, cgroup v2, mount, XFS tools, space, Compose and a slot reserving three TLS ports are available"
