import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LinuxNodeMetricsCollector,
  parseNftBridgeFilters,
  type ReadOnlyCommand,
  type ReadOnlyNodeFileSystem,
} from './collector.js';
import { CORE_NODE_METRIC_CATALOG, validateNodeMetricSample } from '@nyabase/common';

class FakeFileSystem implements ReadOnlyNodeFileSystem {
  constructor(
    private readonly files: Record<string, string>,
    private readonly dirs: Record<string, string[]> | string[] = {},
  ) {}

  async readFile(path: string): Promise<string> {
    const value = this.files[path];
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  }

  async readdir(path: string): Promise<string[]> {
    if (Array.isArray(this.dirs)) {
      if (path === '/proc/sys/net/ipv4/conf') return this.dirs;
      throw new Error(`missing dir ${path}`);
    }
    const value = this.dirs[path];
    if (value === undefined) throw new Error(`missing dir ${path}`);
    return value;
  }
}

const NFT_BRIDGE_TABLE = [
  'table bridge incus {',
  '  chain in.eth0 {',
  '    ether type arp arp saddr ip { 192.0.2.10/32 } drop',
  '    ip saddr { 192.0.2.10/32 } drop',
  '  }',
  '}',
].join('\n');

function commandForFixtures(): ReadOnlyCommand {
  return async (file, args) => {
    if (file === 'smartctl') {
      return { stdout: JSON.stringify({ smart_status: { passed: true } }) };
    }
    if (file === 'ip' && args[0] === '-4' && args[1] === '-o' && args[2] === 'addr' && args[3] === 'show') {
      return { stdout: '2: eno1    inet 192.0.2.10/24 brd 192.0.2.255 scope global eno1\n' };
    }
    if (file === 'nft') {
      expect(args).toEqual(['list', 'table', 'bridge', 'incus']);
      return { stdout: NFT_BRIDGE_TABLE };
    }
    throw new Error(`unexpected command ${file}`);
  };
}

describe('LinuxNodeMetricsCollector', () => {
  it('collects read-only CPU, PSI, disk, SMART, and network evidence', async () => {
    const files = {
      '/proc/stat': [
        'cpu0 110 0 20 870 0 0 0 0 0 0',
        'cpu1 100 0 20 880 0 0 0 0 0 0',
      ].join('\n'),
      '/proc/pressure/cpu': 'some avg10=1.00 avg60=2.00 avg300=3.00 total=4\n',
      '/proc/diskstats': '8 0 sda 1 0 2048 4 2 0 1024 2 0 0 0 0 0 0 0 0 0\n',
      '/sys/class/block/sda/device/wwid': 'wwn-0x1234\n',
      '/proc/123/cgroup': '0::/system.slice/nyabase-11111111-1111-4111-8111-111111111111.scope\n',
      '/proc/sys/net/ipv4/conf/eno1/forwarding': '1\n',
      '/proc/sys/net/ipv4/conf/eno1/rp_filter': '1\n',
    };
    const fileSystem = new FakeFileSystem(files, ['eno1']);
    const collector = new LinuxNodeMetricsCollector({
      parentInterface: 'eno1',
      fileSystem,
      command: commandForFixtures(),
    });

    const first = await collector.collect();
    expect(first.some((sample) => sample.name === 'nyabase_node_cpu_usage_ratio')).toBe(false);
    files['/proc/stat'] = [
      'cpu0 120 0 25 875 0 0 0 0 0 0',
      'cpu1 110 0 25 885 0 0 0 0 0 0',
    ].join('\n');
    const second = await collector.collect();
    for (const sample of [...first, ...second]) validateNodeMetricSample(sample, CORE_NODE_METRIC_CATALOG);

    expect(second).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'nyabase_node_cpu_usage_ratio',
        labels: { cpu: '0' },
      }),
      expect.objectContaining({
        name: 'nyabase_node_disk_io_read_bytes_total',
        labels: { device_id: 'wwn-0x1234' },
      }),
      expect.objectContaining({
        name: 'nyabase_node_disk_smart_health',
        value: 1,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_fib_rule_present',
        labels: { interface: 'eno1' },
        value: 0,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_is_bridge',
        labels: { interface: 'eno1' },
        value: 0,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_ipv4_present',
        labels: { interface: 'eno1' },
        value: 1,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_nft_available',
        labels: {},
        value: 1,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_bridge_filter_present',
        labels: {},
        value: 1,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_bridge_filter_address',
        labels: { address: '192.0.2.10' },
        value: 1,
      }),
    ]));
    expect(second.some((sample) => sample.labels && 'pid' in sample.labels)).toBe(false);
  });




  it('does not fabricate unavailable capabilities or expose a mutation surface', async () => {
    const collector = new LinuxNodeMetricsCollector({
      fileSystem: new FakeFileSystem({}, []),
      command: async () => {
        throw new Error('unavailable');
      },
    });
    expect(await collector.collect()).toEqual([
      expect.objectContaining({
        name: 'nyabase_node_network_nft_available',
        labels: {},
        value: 0,
      }),
    ]);

    const source = [
      readFileSync(resolve(process.cwd(), 'src/collector.ts'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'src/server.ts'), 'utf8'),
    ].join('\n');
    expect(source).not.toMatch(/\b(?:writeFile|appendFile|unlink|rm|rename)\s*\(/);
    expect(source).not.toMatch(/\b(?:docker|WebSocket)\b/i);
    expect(source).toContain("['list', 'table', 'bridge', 'incus']");
  });

  it('emits bridge sysfs, slave, ipv4_present, and parsed nft allowlist addresses', async () => {
    const files = {
      '/proc/sys/net/ipv4/conf/vmbr0/forwarding': '0\n',
      '/proc/sys/net/ipv4/conf/vmbr0/rp_filter': '0\n',
      '/proc/sys/net/ipv4/conf/bond0/forwarding': '0\n',
      '/proc/sys/net/ipv4/conf/bond0/rp_filter': '0\n',
    };
    const dirs = {
      '/proc/sys/net/ipv4/conf': ['vmbr0', 'bond0'],
      '/sys/class/net': ['vmbr0', 'bond0'],
      '/sys/class/net/vmbr0/bridge': [],
      '/sys/class/net/vmbr0/brif': ['bond0'],
    };
    const collector = new LinuxNodeMetricsCollector({
      fileSystem: new FakeFileSystem(files, dirs),
      command: async (file, args, options) => {
        if (file === 'ip') {
          expect(options.timeout).toBe(250);
          return {
            stdout: [
              '2: vmbr0    inet 192.0.2.1/24 brd 192.0.2.255 scope global vmbr0',
              '3: bond0    inet 169.254.1.1/16 scope link bond0',
              '4: lo    inet 127.0.0.1/8 scope host lo',
            ].join('\n'),
          };
        }
        if (file === 'nft') {
          expect(args).toEqual(['list', 'table', 'bridge', 'incus']);
          expect(options.timeout).toBe(400);
          return { stdout: NFT_BRIDGE_TABLE };
        }
        if (file === 'smartctl') {
          throw new Error('unavailable');
        }
        throw new Error(`unexpected command ${file}`);
      },
    });

    const samples = await collector.collect();
    for (const sample of samples) validateNodeMetricSample(sample, CORE_NODE_METRIC_CATALOG);
    expect(samples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'nyabase_node_network_is_bridge',
        labels: { interface: 'vmbr0' },
        value: 1,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_is_bridge',
        labels: { interface: 'bond0' },
        value: 0,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_bridge_slave',
        labels: { bridge: 'vmbr0', interface: 'bond0' },
        value: 1,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_ipv4_present',
        labels: { interface: 'vmbr0' },
        value: 1,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_ipv4_present',
        labels: { interface: 'bond0' },
        value: 0,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_bridge_filter_address',
        labels: { address: '192.0.2.10' },
        value: 1,
      }),
    ]));
  });

  it('omits ipv4_present when ip addr show fails instead of emitting zeros', async () => {
    const dirs = {
      '/proc/sys/net/ipv4/conf': ['vmbr0', 'eth1'],
      '/sys/class/net': ['vmbr0', 'eth1'],
      '/sys/class/net/vmbr0/bridge': [],
      '/sys/class/net/vmbr0/brif': ['eth1'],
    };
    const collector = new LinuxNodeMetricsCollector({
      fileSystem: new FakeFileSystem({}, dirs),
      command: async (file) => {
        if (file === 'ip') throw new Error('ip failed');
        if (file === 'nft') {
          throw Object.assign(new Error('nft failed'), {
            stderr: 'Error: No such file or directory\n',
          });
        }
        throw new Error(`unexpected command ${file}`);
      },
    });
    const samples = await collector.collect();
    for (const sample of samples) validateNodeMetricSample(sample, CORE_NODE_METRIC_CATALOG);
    expect(samples.some((sample) => sample.name === 'nyabase_node_network_ipv4_present')).toBe(false);
    expect(samples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'nyabase_node_network_bridge_slave',
        labels: { bridge: 'vmbr0', interface: 'eth1' },
        value: 1,
      }),
    ]));
  });

  it('treats a missing nft table as available with no filter samples', async () => {
    const collector = new LinuxNodeMetricsCollector({
      fileSystem: new FakeFileSystem({}, []),
      command: async (file) => {
        if (file === 'nft') {
          throw Object.assign(new Error('nft failed'), {
            stderr: 'Error: No such file or directory\n',
          });
        }
        if (file === 'ip' || file === 'smartctl') {
          throw new Error('unavailable');
        }
        throw new Error(`unexpected command ${file}`);
      },
    });
    const samples = await collector.collect();
    for (const sample of samples) validateNodeMetricSample(sample, CORE_NODE_METRIC_CATALOG);
    expect(samples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'nyabase_node_network_nft_available',
        labels: {},
        value: 1,
      }),
      expect.objectContaining({
        name: 'nyabase_node_network_bridge_filter_present',
        labels: {},
        value: 0,
      }),
    ]));
    expect(samples.some((sample) => sample.name === 'nyabase_node_network_bridge_filter_address'))
      .toBe(false);
  });

  it('emits nft_available=0 on missing binary, permission, or timeout', async () => {
    const run = async (error: unknown) => {
      const collector = new LinuxNodeMetricsCollector({
        fileSystem: new FakeFileSystem({}, []),
        command: async (file) => {
          if (file === 'nft') throw error;
          throw new Error('unavailable');
        },
      });
      return collector.collect();
    };
    for (const error of [
      Object.assign(new Error('enoent'), { code: 'ENOENT' }),
      Object.assign(new Error('eacces'), { code: 'EACCES' }),
      Object.assign(new Error('timeout'), { killed: true }),
    ]) {
      const samples = await run(error);
      expect(samples).toEqual([
        expect.objectContaining({
          name: 'nyabase_node_network_nft_available',
          labels: {},
          value: 0,
        }),
      ]);
    }
  });
});

const INCUS_74_BRIDGE_TABLE = [
  'table bridge incus {',
  'chain in.e2e-nft-probe-tmp.eth0 {',
  'type filter hook input priority filter; policy accept;',
  'iifname "vetha79c94da" ether saddr != 10:66:6a:9e:db:b1 drop',
  'iifname "vetha79c94da" arp saddr ether != 10:66:6a:9e:db:b1 drop',
  'iifname "vetha79c94da" icmpv6 type nd-neighbor-advert @nh,528,48 != 0x10666a9edbb1 drop',
  'iifname "vetha79c94da" ip saddr 0.0.0.0 ip daddr 255.255.255.255 udp dport 67 accept',
  'iifname "vetha79c94da" arp saddr ip != 10.8.255.254 drop',
  'iifname "vetha79c94da" ip saddr != 10.8.255.254 drop',
  'iifname "vetha79c94da" ether type != { ip, arp, ip6 } drop',
  '}',
  '}',
].join('\n');

describe('parseNftBridgeFilters', () => {
  it('reads classic Incus set-based drop rules', () => {
    expect(parseNftBridgeFilters(NFT_BRIDGE_TABLE)).toEqual({
      present: true,
      addresses: ['192.0.2.10'],
    });
  });

  it('reads Incus 7.4 inequality anti-spoof rules without address sets', () => {
    expect(parseNftBridgeFilters(INCUS_74_BRIDGE_TABLE)).toEqual({
      present: true,
      addresses: ['10.8.255.254'],
    });
  });
});
