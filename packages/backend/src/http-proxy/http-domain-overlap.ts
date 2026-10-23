import { httpProxyWildcardSuffix } from '@nyabase/common';

/**
 * Domain pools must be disjoint DNS subtrees. With `*.example.com` and
 * `*.a.example.com` both present, a user of the first pool could bind
 * `a.example.com`, the parent of every site in the second, and set cookies
 * (`Domain=a.example.com`) that all of them receive. So no pool's domain may
 * equal or lie under another's; given that, no hostname bound in one pool
 * can be an ancestor of another pool's sites.
 */
export function wildcardDomainsOverlap(first: string, second: string): boolean {
  const a = httpProxyWildcardSuffix(first);
  const b = httpProxyWildcardSuffix(second);
  // Both start with '.', so a suffix match is always on a label boundary.
  return a.endsWith(b) || b.endsWith(a);
}

/**
 * Whether binding `hostname` would be the base domain of the pool
 * `wildcardDomain`, or an ancestor of it. Disjoint pools never allow this;
 * the check keeps binding validation safe on its own.
 */
export function hostnameCoversWildcardDomain(hostname: string, wildcardDomain: string): boolean {
  const base = httpProxyWildcardSuffix(wildcardDomain).slice(1);
  return base === hostname || base.endsWith(`.${hostname}`);
}
