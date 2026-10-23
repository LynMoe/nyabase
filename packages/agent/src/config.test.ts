import { describe, expect, it } from 'vitest';
import { controlUrl, loadAgentConfig, parseBackendUrl, parseGuestBridges } from './config.js';

describe('agent backend URL', () => {
  it('accepts https origins and maps them to wss', () => {
    const backendUrl = parseBackendUrl('https://nyabase.example.com');
    expect(controlUrl({ backendUrl })).toMatch(/^wss:\/\/nyabase\.example\.com\//);
  });

  it.each([
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    'http://127.12.0.9',
    'http://[::1]:3001',
  ])('accepts plaintext only to loopback: %s', (value) => {
    const backendUrl = parseBackendUrl(value);
    expect(controlUrl({ backendUrl })).toMatch(/^ws:\/\//);
  });

  it.each([
    'http://nyabase.example.com',
    'http://10.0.0.1:3001',
    'http://128.0.0.1',
    'http://[::ffff:7f00:1]',
    'http://localhost.example.com',
    'http://127.0.0.1.nip.io',
    'ws://127.0.0.1:3001',
    'https://nyabase.example.com/api',
    'https://user:pass@nyabase.example.com',
  ])('refuses %s', (value) => {
    expect(() => parseBackendUrl(value)).toThrow();
  });

  it('refuses a plaintext non-loopback backend at load time', async () => {
    await expect(loadAgentConfig({ NYABASE_BACKEND_URL: 'http://192.0.2.10:3001' })).rejects.toThrow(/https/);
  });
});

describe('agent guest bridges', () => {
  it('reads a comma separated list of interface names', async () => {
    expect(parseGuestBridges(' vmbr0, br-lan ,vmbr0,')).toEqual(['vmbr0', 'br-lan']);
    expect(parseGuestBridges('')).toEqual([]);
    const config = await loadAgentConfig({ NYABASE_BACKEND_URL: 'https://nyabase.example.com', NYABASE_AGENT_GUEST_BRIDGES: 'vmbr0' });
    expect(config.guestBridges).toEqual(['vmbr0']);
  });

  it.each(['br 0', 'a-name-longer-than-15', '..', 'br0/x'])('refuses %s', (value) => {
    expect(() => parseGuestBridges(value)).toThrow(/NYABASE_AGENT_GUEST_BRIDGES/);
  });
});
