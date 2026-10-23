/**
 * What a failed proxy snapshot build means for the connected proxies. Nothing
 * is sent: each proxy keeps the last snapshot it received only until that
 * snapshot's own lease ends and then fails closed (no routes, no logins)
 * until a build succeeds. Re-sending the old routes with a fresh lease would
 * let a revocation committed since then outlive the lease, which is exactly
 * what the lease exists to bound, so the gateways never do that; the failure
 * is logged at error level with the time the proxies will fail closed.
 */
export function snapshotBuildFailureMessage(
  proxy: 'HTTP' | 'SSH',
  error: unknown,
  leaseEnds: Iterable<number>,
  now = Date.now(),
): string {
  const reason = error instanceof Error ? error.message : String(error);
  let earliest: number | null = null;
  for (const leaseEnd of leaseEnds) {
    if (!Number.isFinite(leaseEnd)) continue;
    if (earliest === null || leaseEnd < earliest) earliest = leaseEnd;
  }
  let outcome: string;
  if (earliest === null) {
    outcome = 'no connected proxy holds a snapshot from this Backend';
  } else if (earliest > now) {
    const seconds = Math.ceil((earliest - now) / 1000);
    outcome = `proxies keep their last snapshot until ${new Date(earliest).toISOString()} `
      + `(${seconds} s) and then fail closed until a build succeeds`;
  } else {
    outcome = 'proxy snapshot leases have run out; proxies fail closed until a build succeeds';
  }
  return `${proxy} proxy snapshot build failed: ${reason}; ${outcome}`;
}
