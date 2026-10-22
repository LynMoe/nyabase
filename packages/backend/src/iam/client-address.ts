import { isIP } from 'node:net';

/**
 * Rate-limit bucket for a client address (Express `req.ip`, which already
 * honours `server.trustedProxies`). IPv4 (and IPv4-mapped IPv6) is one bucket
 * per address; IPv6 is bucketed by its /64 because a single client usually
 * controls a whole /64 and could otherwise rotate addresses for free.
 */
export function clientAddressBucket(raw: string | undefined): string {
  const address = (raw ?? '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return 'unknown';
  const groups = expandIpv6(address);
  return groups
    ? `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`
    : 'unknown';
}

function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  // An embedded dotted IPv4 tail occupies the last two groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const octets = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length)
      + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest]
    .map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}
