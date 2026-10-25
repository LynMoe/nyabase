import { describe, expect, it } from 'vitest';
import {
  HTTP_PROXY_LIVE_SAMPLE_MAX_AGE_MS,
  HttpProxyLiveTraffic,
  countersByBinding,
} from './http-proxy-live-traffic.js';

const binding = 'binding-a';

function sample(requests: number, active: number, rxBytes: number, txBytes: number) {
  return countersByBinding([{ bindingId: binding, requests, activeConnections: active, rxBytes, txBytes }]);
}

describe('HttpProxyLiveTraffic', () => {
  it('has no rate before a proxy has two reports, but already counts its active connections', () => {
    const traffic = new HttpProxyLiveTraffic();
    traffic.record({}, 'p:1', sample(1, 2, 100, 1_000), 1_000);
    expect(traffic.live([binding], 1_000).get(binding)).toEqual({
      activeConnections: 2,
      rxBytesPerSec: null,
      txBytesPerSec: null,
    });
  });

  it('rates are the counter growth over the report window, summed over proxies', () => {
    const traffic = new HttpProxyLiveTraffic();
    const first = {};
    const second = {};
    traffic.record(first, 'p1:1', sample(1, 1, 0, 0), 0);
    traffic.record(first, 'p1:1', sample(2, 1, 2_000, 10_000), 2_000);
    traffic.record(second, 'p2:1', sample(5, 3, 500, 500), 0);
    traffic.record(second, 'p2:1', sample(6, 0, 1_500, 500), 1_000);
    expect(traffic.live([binding, 'other'], 2_000)).toEqual(new Map([
      [binding, { activeConnections: 1, rxBytesPerSec: 2_000, txBytesPerSec: 5_000 }],
      ['other', { activeConnections: 0, rxBytesPerSec: 0, txBytesPerSec: 0 }],
    ]));
  });

  it('averages over at least the rate window once the history is long enough', () => {
    const traffic = new HttpProxyLiveTraffic();
    const connection = {};
    for (let second = 0; second <= 10; second += 1) {
      // 1 KB/s, except one 10 KB burst in the last second.
      const rx = second * 1_000 + (second === 10 ? 9_000 : 0);
      traffic.record(connection, 'p:1', sample(second, 0, rx, 0), second * 1_000);
    }
    // Window [5 s, 10 s]: (19 000 - 5 000) / 5.
    expect(traffic.live([binding], 10_000).get(binding)?.rxBytesPerSec).toBe(2_800);
  });

  it('forgets a disconnected or silent proxy', () => {
    const traffic = new HttpProxyLiveTraffic();
    const gone = {};
    const silent = {};
    traffic.record(gone, 'p1:1', sample(1, 4, 0, 0), 0);
    traffic.record(silent, 'p2:1', sample(1, 2, 0, 0), 0);
    traffic.forget(gone);
    expect(traffic.live([binding], 1).get(binding)?.activeConnections).toBe(2);
    expect(traffic.live([binding], HTTP_PROXY_LIVE_SAMPLE_MAX_AGE_MS + 1).get(binding))
      .toEqual({ activeConnections: 0, rxBytesPerSec: null, txBytesPerSec: null });
  });

  it('a counter that went backwards (a new instance on the connection) restarts the history', () => {
    const traffic = new HttpProxyLiveTraffic();
    const connection = {};
    traffic.record(connection, 'p:1', sample(10, 0, 10_000, 0), 0);
    traffic.record(connection, 'p:2', sample(1, 0, 100, 0), 1_000);
    expect(traffic.live([binding], 1_000).get(binding)?.rxBytesPerSec).toBeNull();
  });
});
