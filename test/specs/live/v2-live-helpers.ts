import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';

export type Persona = 'alpha' | 'beta' | 'gamma' | 'delta' | 'epsilon';
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type ApiResult<T = unknown> = { method: HttpMethod; path: string; status: number; ok: boolean; body: T };
export type OperationRef = { ok: true; operationId: string; status: string };
export type OperationView = { id: string; status: string; resourceId: string; lastError: string | null };
export type ContainerView = {
  id: string;
  serverId: string;
  ownerId: string;
  name: string;
  imageId: string;
  phase: string;
  runtime: { bound: boolean; runtimeId: string | null; status: string | null; stale: boolean };
  actions: Record<string, { enabled: boolean; reason?: string; message?: string; operationId?: string }>;
};

export type SetupState = {
  runPrefix: string;
  backendUrl: string;
  servers: { cpu: { id: string }; gpu: { id: string } | null };
  images: Record<string, { id: string } | null>;
  users: Record<Persona, { username: string; credentialFile: string; id: string }>;
};

export async function loadState(): Promise<SetupState> {
  const explicit = process.env.NYABASE_MURT_STATE ?? process.env.NYABASE_MURT_STATE_PATH;
  const path = explicit ?? await statePathFromCurrentEnv();
  return JSON.parse(await readFile(path, 'utf8')) as SetupState;
}

async function statePathFromCurrentEnv(): Promise<string> {
  const envText = await readFile('test/runtime/murt/current.env', 'utf8');
  const match = /^NYABASE_MURT_STATE=(.*)$/m.exec(envText) ?? /^NYABASE_MURT_STATE_PATH=(.*)$/m.exec(envText);
  if (!match?.[1]) throw new Error('Missing NYABASE_MURT_STATE in test/runtime/murt/current.env');
  return match[1].trim();
}

export function apiBase(state: SetupState): string {
  return `${(process.env.NYABASE_BACKEND_URL ?? state.backendUrl ?? 'http://localhost:3001').replace(/\/$/, '')}/api`;
}

export async function loadActor(state: SetupState, persona: Persona) {
  const content = await readFile(state.users[persona].credentialFile, 'utf8');
  const username = /USERNAME=(.*)/.exec(content)?.[1]?.trim() ?? state.users[persona].username;
  const password = /PASSWORD=(.*)/.exec(content)?.[1]?.trim();
  if (!password) throw new Error(`missing password in ${state.users[persona].credentialFile}`);
  const login = await rawApi<{ accessToken: string; user: { id: string; username: string } }>(state, 'POST', '/auth/login', undefined, { username, password });
  expect(login.status).toBe(200);
  return { persona, token: login.body.accessToken, user: login.body.user };
}

export async function rawApi<T = unknown>(state: SetupState, method: HttpMethod, path: string, token?: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(`${apiBase(state)}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const data = res.status === 204 ? null : contentType.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { method, path, status: res.status, ok: res.ok, body: data as T };
}

export async function api<T = unknown>(state: SetupState, method: HttpMethod, path: string, token?: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await rawApi<T>(state, method, path, token, body);
  if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

export async function waitOperationSucceeded(state: SetupState, token: string, operationId: string, timeoutMs = 120_000): Promise<OperationView> {
  const deadline = Date.now() + timeoutMs;
  let last: OperationView | null = null;
  while (Date.now() < deadline) {
    const res = await api<OperationView>(state, 'GET', `/operations/${operationId}`, token);
    last = res.body;
    if (['succeeded', 'failed', 'cancelled'].includes(last.status)) {
      expect(last.status, `operation ${operationId} failed: ${last.lastError ?? ''}`).toBe('succeeded');
      return last;
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting operation ${operationId}; last=${last?.status ?? 'unknown'} ${last?.lastError ?? ''}`);
}

export async function waitContainerPhase(state: SetupState, token: string, containerId: string, phase: string, timeoutMs = 90_000): Promise<ContainerView> {
  const deadline = Date.now() + timeoutMs;
  let last: ContainerView | null = null;
  while (Date.now() < deadline) {
    const res = await rawApi<ContainerView>(state, 'GET', `/v2/containers/${containerId}`, token);
    if (res.status === 404 && phase === 'deleted') return { id: containerId, phase: 'deleted' } as ContainerView;
    if (res.ok) {
      last = res.body;
      if (last.phase === phase) return last;
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting container ${containerId} phase ${phase}; last=${last?.phase ?? 'missing'}`);
}

export async function waitActionEnabled(state: SetupState, token: string, containerId: string, action: string, timeoutMs = 90_000): Promise<ContainerView> {
  const deadline = Date.now() + timeoutMs;
  let last: ContainerView | null = null;
  while (Date.now() < deadline) {
    last = (await api<ContainerView>(state, 'GET', `/v2/containers/${containerId}`, token)).body;
    if (last.actions?.[action]?.enabled) return last;
    await sleep(1000);
  }
  const a = last?.actions?.[action];
  throw new Error(`timed out waiting action ${action} enabled for ${containerId}; phase=${last?.phase} reason=${a?.reason} message=${a?.message}`);
}

export async function createContainerActive(state: SetupState, token: string, input: { serverId: string; imageId: string; name: string; cpuMillis?: number; memBytes?: number; gpuIndices?: number[] }): Promise<ContainerView> {
  const ref = (await api<OperationRef>(state, 'POST', '/v2/containers', token, {
    cpuMillis: 100,
    memBytes: 64 * 1024 * 1024,
    gpuIndices: [],
    ...input,
  })).body;
  const op = await waitOperationSucceeded(state, token, ref.operationId);
  const view = await waitContainerPhase(state, token, op.resourceId, 'active');
  await waitActionEnabled(state, token, op.resourceId, 'delete');
  return view;
}

export async function containerAction(state: SetupState, token: string, containerId: string, action: string, body?: unknown): Promise<OperationView> {
  await waitActionEnabled(state, token, containerId, action);
  const ref = (await api<OperationRef>(state, 'POST', `/v2/containers/${containerId}/actions/${kebab(action)}`, token, body)).body;
  return waitOperationSucceeded(state, token, ref.operationId);
}

export async function removeContainerViaOperation(state: SetupState, token: string, containerId: string): Promise<void> {
  await containerAction(state, token, containerId, 'delete');
  await waitContainerPhase(state, token, containerId, 'deleted');
}

export async function sleep(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

function kebab(action: string): string {
  return action.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
