import { isIP } from 'node:net';
import {
  IncusError,
  requestAndWait,
  type IncusClientPort,
} from '../incus/index.js';

export interface GuestNetworkConfig {
  readonly address: string;
  readonly prefixLength: number;
  readonly gateway: string;
  readonly dnsServers: readonly string[];
  readonly interfaceName?: string;
}

export function parseCidrPrefix(networkKey: string): number | undefined {
  const match = /^(.+)\/(\d{1,2})$/.exec(networkKey.trim());
  if (!match) return undefined;
  if (isIP(match[1]) !== 4) return undefined;
  const prefix = Number(match[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
  return prefix;
}

export function buildGuestNetworkScript(config: GuestNetworkConfig): string {
  if (isIP(config.address) !== 4 || config.address.includes('/')) {
    throw new Error('invalid_guest_ipv4');
  }
  if (isIP(config.gateway) !== 4 || config.gateway.includes('/')) {
    throw new Error('invalid_guest_gateway');
  }
  if (!Number.isInteger(config.prefixLength) || config.prefixLength < 0 || config.prefixLength > 32) {
    throw new Error('invalid_guest_prefix');
  }
  const iface = config.interfaceName?.trim() || 'eth0';
  if (!/^[A-Za-z0-9._-]{1,15}$/.test(iface)) {
    throw new Error('invalid_guest_interface');
  }
  const cidr = `${config.address}/${config.prefixLength}`;
  const dnsIpv4 = config.dnsServers.filter((server) => isIP(server) === 4);
  const dnsLines = dnsIpv4.map((server) => `nameserver ${server}`);
  const resolv = dnsLines.length > 0
    ? `rm -f /etc/resolv.conf && printf '%s\\n' ${dnsLines.map((line) => shellQuote(line)).join(' ')} > /etc/resolv.conf`
    : 'true';
  const networkdDns = dnsIpv4.map((server) => `DNS=${server}`);
  return [
    'set -euo pipefail',
    `IFACE=${shellQuote(iface)}`,
    `ADDR=${shellQuote(cidr)}`,
    `GW=${shellQuote(config.gateway)}`,
    'ip link set "$IFACE" up',
    'ip addr replace "$ADDR" dev "$IFACE"',
    'ip route replace default via "$GW" dev "$IFACE"',
    resolv,
    // Persist the claim address so Incus last-state start after host reboot
    // restores L3 without waiting for the next drifted scan.
    'if mkdir -p /etc/systemd/network; then',
    '  {',
    '    printf \'%s\\n\' \'[Match]\' "Name=$IFACE" \'[Network]\' \'DHCP=no\' "Address=$ADDR" "Gateway=$GW"',
    ...networkdDns.map((line) => `    printf '%s\\n' ${shellQuote(line)}`),
    '  } > /etc/systemd/network/10-nyabase-eth0.network || true',
    'fi',
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationReturnCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.return === 'number' && Number.isSafeInteger(value.return)) {
    return value.return;
  }
  return operationReturnCode(value.metadata);
}

export async function applyGuestNetwork(
  client: IncusClientPort,
  instanceName: string,
  config: GuestNetworkConfig,
  signal?: AbortSignal,
): Promise<void> {
  const script = buildGuestNetworkScript(config);
  let result;
  try {
    result = await requestAndWait(
      client,
      (options) => client.execInstance(
        instanceName,
        {
          command: ['bash', '-c', script],
          'record-output': false,
        },
        options,
      ),
      { signal },
    );
  } catch (error) {
    if (
      error instanceof IncusError
      && (error.code === 'INCUS_BAD_REQUEST' || error.code === 'INSTANCE_BUSY')
      && typeof error.details?.error === 'string'
      && /not running|busy/i.test(error.details.error)
    ) {
      throw new IncusError('GUEST_NOT_READY', 'retry', {
        reason: 'guest_network_instance_not_ready',
      });
    }
    throw error;
  }
  const code = operationReturnCode(result);
  if (code !== undefined && code !== 0) {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'retry', {
      reason: 'guest_network_apply_failed',
      returnCode: code,
    });
  }
}
