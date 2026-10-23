import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import type {
  IncusHttpMethod,
  IncusTunnel,
  IncusTunnelRequest,
  IncusTunnelResponse,
  IncusWebSocketLike,
} from './incus/index.js';
import { IncusError } from './incus/index.js';

/*
 * The host agent's side of the tunnel for agent-policy.contract.test.ts:
 * every request the Backend's real IncusClient emits goes through the agent's
 * real policy (packages/agent/src/policy.ts) and operation ledger, and only
 * the body the policy forwards reaches a small in-memory Incus.
 */

/** The verdict shape of the agent's checkIncusHttp. */
type PolicyVerdict =
  | { readonly allowed: true; readonly body?: Buffer; readonly needsIpv6Guard?: boolean }
  | { readonly allowed: false; readonly reason: string; readonly notFound?: boolean };

interface OperationLedger {
  knows(id: string): boolean;
  recordResponse(status: number, body: Buffer): void;
}

/** The slice of the agent's policy and operation-ledger modules this harness drives. */
interface AgentPolicyModules {
  checkIncusHttp(
    request: { readonly method: IncusHttpMethod; readonly path: string; readonly body?: Buffer },
    context: {
      readonly readCurrent: (path: string) => Promise<Record<string, unknown> | undefined>;
      readonly operations: OperationLedger;
    },
  ): Promise<PolicyVerdict>;
  checkIncusWebSocket(
    path: string,
    operations: OperationLedger,
  ): { readonly allowed: true } | { readonly allowed: false; readonly reason: string };
  OperationLedger: new () => OperationLedger;
}

/*
 * The agent is not a Backend dependency (the Backend image never builds it),
 * so its sources are loaded by path: vitest compiles them like this package's
 * own, with @nyabase/common resolved to the same source tree.
 */
const AGENT_SOURCE = resolve(__dirname, '../../agent/src');

async function loadAgentPolicy(): Promise<AgentPolicyModules> {
  const policy = (await import(join(AGENT_SOURCE, 'policy.ts'))) as Omit<AgentPolicyModules, 'OperationLedger'>;
  const ledger = (await import(join(AGENT_SOURCE, 'operation-ledger.ts'))) as Pick<AgentPolicyModules, 'OperationLedger'>;
  return { ...policy, OperationLedger: ledger.OperationLedger };
}

class FakeSocket extends EventEmitter implements IncusWebSocketLike {
  readyState = 1;

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.close();
  }
}

export class AgentPolicyTunnel implements IncusTunnel {
  /** Every request and WebSocket the policy refused (or forwarded altered), as `METHOD path: reason`. */
  readonly refusals: string[] = [];
  /** `METHOD path` of every request the policy let through, query stripped. */
  readonly forwarded: string[] = [];
  readonly host = new FakeIncusHost();
  private readonly operations: OperationLedger;

  private constructor(private readonly policy: AgentPolicyModules) {
    this.operations = new policy.OperationLedger();
  }

  static async create(): Promise<AgentPolicyTunnel> {
    return new AgentPolicyTunnel(await loadAgentPolicy());
  }

  /** The mutating requests forwarded so far (GETs left out). */
  get mutations(): string[] {
    return this.forwarded.filter((request) => !request.startsWith('GET '));
  }

  async request(request: IncusTunnelRequest): Promise<IncusTunnelResponse> {
    const label = `${request.method} ${request.path.split('?')[0]}`;
    const verdict = await this.policy.checkIncusHttp(
      { method: request.method, path: request.path, body: request.body },
      { readCurrent: async (path) => this.host.current(path), operations: this.operations },
    );
    if (!verdict.allowed) {
      if (verdict.notFound) return errorResponse(404, 'Operation not found');
      this.refusals.push(`${label}: ${verdict.reason}`);
      throw new IncusError('AGENT_POLICY_DENIED', 'managed_failure', { message: verdict.reason });
    }
    // The policy re-serializes JSON bodies; for what the Backend sends, that must change nothing.
    if (isJson(request) && !sameJson(request.body, verdict.body)) {
      this.refusals.push(`${label}: the agent would forward a different body`);
    }
    this.forwarded.push(label);
    const response = this.host.handle(request.method, request.path, request.headers, verdict.body);
    this.operations.recordResponse(response.status, response.body);
    return response;
  }

  async openWebSocket(path: string): Promise<IncusWebSocketLike> {
    const verdict = this.policy.checkIncusWebSocket(path, this.operations);
    if (!verdict.allowed) {
      this.refusals.push(`WS ${path.split('?')[0]}: ${verdict.reason}`);
      throw new IncusError('AGENT_POLICY_DENIED', 'managed_failure', { message: verdict.reason });
    }
    this.forwarded.push(`WS ${path.split('?')[0]}`);
    return new FakeSocket();
  }
}

function isJson(request: IncusTunnelRequest): boolean {
  return Object.entries(request.headers)
    .some(([name, value]) => name.toLowerCase() === 'content-type' && value.includes('json'));
}

function sameJson(sent: Buffer | undefined, forwarded: Buffer | undefined): boolean {
  if (!sent || !forwarded) return sent === forwarded;
  return JSON.stringify(sortKeys(JSON.parse(sent.toString()))) === JSON.stringify(sortKeys(JSON.parse(forwarded.toString())));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
}

type Document = Record<string, unknown>;

function jsonResponse(status: number, envelope: Document, etag?: string): IncusTunnelResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
    body: Buffer.from(JSON.stringify(envelope)),
  };
}

function sync(metadata: unknown, etag?: string): IncusTunnelResponse {
  return jsonResponse(200, { type: 'sync', status: 'Success', status_code: 200, metadata }, etag);
}

function errorResponse(status: number, error: string): IncusTunnelResponse {
  return jsonResponse(status, { type: 'error', status: '', status_code: 0, error_code: status, error, metadata: null });
}

function etagOf(document: Document): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

const PUT_INSTANCE_FIELDS = ['architecture', 'config', 'description', 'devices', 'ephemeral', 'profiles', 'stateful'];

/**
 * Just enough of an Incus daemon for the Backend's flows to complete: it keeps
 * instances, custom volumes and images, adds the volatile.* / image.* keys
 * Incus adds, and finishes every operation successfully.
 */
export class FakeIncusHost {
  readonly instances = new Map<string, Document>();
  readonly volumes = new Map<string, Document>();
  readonly images = new Map<string, Document>();
  private readonly operations = new Map<string, unknown>();
  private clock = Date.parse('2026-01-01T00:00:00Z');

  /** What the agent reads as the current document (instance or volume) before an update. */
  current(path: string): Document | undefined {
    const segments = new URL(path, 'http://incus').pathname.split('/').slice(2).map(decodeURIComponent);
    if (segments[0] === 'instances') return this.instances.get(segments[1] ?? '');
    if (segments[0] === 'storage-pools') return this.volumes.get(`${segments[1]}/${segments[4]}`);
    return undefined;
  }

  handle(
    method: IncusHttpMethod,
    path: string,
    headers: Readonly<Record<string, string>>,
    body: Buffer | undefined,
  ): IncusTunnelResponse {
    const url = new URL(path, 'http://incus');
    const segments = url.pathname.split('/').slice(2).map(decodeURIComponent);
    const json = (): Document => (body && body.byteLength > 0 ? JSON.parse(body.toString()) as Document : {});
    const ifMatch = Object.entries(headers).find(([name]) => name.toLowerCase() === 'if-match')?.[1];
    switch (segments[0]) {
      case undefined:
        return sync({ api_extensions: [], environment: { server_version: '6.0' } });
      case 'instances':
        return this.instance(method, segments.slice(1), json, ifMatch);
      case 'storage-pools':
        return this.storage(method, segments.slice(1), json);
      case 'images':
        return this.image(method, segments.slice(1), json);
      case 'operations': {
        const [id] = segments.slice(1);
        if (!id || !this.operations.has(id)) return errorResponse(404, 'Operation not found');
        return sync({ id, status: 'Success', status_code: 200, metadata: this.operations.get(id) });
      }
      default:
        if (method === 'GET') return sync({});
        throw new Error(`the fake Incus host does not implement ${method} ${url.pathname}`);
    }
  }

  private operation(metadata: unknown): IncusTunnelResponse {
    const id = randomUUID();
    this.operations.set(id, metadata);
    return jsonResponse(202, {
      type: 'async',
      status: 'Operation created',
      status_code: 100,
      operation: `/1.0/operations/${id}`,
      metadata: { id, status: 'Running', status_code: 103, metadata },
    });
  }

  private instance(
    method: IncusHttpMethod,
    [name, leaf]: readonly string[],
    json: () => Document,
    ifMatch: string | undefined,
  ): IncusTunnelResponse {
    if (name === undefined) {
      if (method === 'GET') return sync([...this.instances.values()].map((document) => this.withState(document)));
      const created = json();
      if (this.instances.has(String(created.name))) return errorResponse(409, 'Instance already exists');
      const devices = (created.devices ?? {}) as Record<string, Document>;
      this.instances.set(String(created.name), {
        name: created.name,
        type: 'container',
        architecture: 'x86_64',
        config: {
          ...(created.config as Document),
          'image.os': 'Debian',
          'volatile.base_image': 'a'.repeat(64),
          'volatile.idmap.base': '1065536',
          ...(devices.eth0 ? { 'volatile.eth0.hwaddr': devices.eth0.hwaddr } : {}),
        },
        devices,
        profiles: [],
        ephemeral: false,
        stateful: false,
        description: '',
        status: 'Stopped',
        started_at: null,
      });
      return this.operation({});
    }
    const document = this.instances.get(name);
    if (!document) return errorResponse(404, 'Instance not found');
    switch (leaf) {
      case undefined:
        return this.instanceDocument(method, name, document, json, ifMatch);
      case 'state':
        if (method === 'GET') return sync({ status: document.status, status_code: 0, started_at: document.started_at });
        return this.powerChange(document, String(json().action));
      case 'exec':
        return this.operation(json()['wait-for-websocket'] === true
          ? { fds: { 0: 'stdin-secret', 1: 'stdout-secret', 2: 'stderr-secret', control: 'control-secret' } }
          : { return: 0, output: {} });
      case 'files':
        return method === 'GET' ? errorResponse(404, 'File not found') : sync({});
      default:
        throw new Error(`the fake Incus host does not implement ${method} instance ${leaf}`);
    }
  }

  private instanceDocument(
    method: IncusHttpMethod,
    name: string,
    document: Document,
    json: () => Document,
    ifMatch: string | undefined,
  ): IncusTunnelResponse {
    switch (method) {
      case 'GET':
        return sync(this.withState(document), etagOf(document));
      case 'DELETE':
        if (document.status === 'Running') return errorResponse(400, 'Instance is running');
        this.instances.delete(name);
        return this.operation({});
      case 'POST': {
        const next = String(json().name);
        this.instances.delete(name);
        this.instances.set(next, { ...document, name: next });
        return this.operation({});
      }
      default: {
        if (ifMatch !== undefined && ifMatch !== etagOf(document)) return errorResponse(412, 'ETag mismatch');
        const update = json();
        const fields = method === 'PUT' ? PUT_INSTANCE_FIELDS : Object.keys(update);
        for (const field of fields) {
          if (Object.hasOwn(update, field)) document[field] = update[field];
        }
        return this.operation({});
      }
    }
  }

  private withState(document: Document): Document {
    return { ...document, state: { status: document.status, started_at: document.started_at } };
  }

  private powerChange(document: Document, action: string): IncusTunnelResponse {
    if (action === 'start' || action === 'restart') {
      this.clock += 1000;
      document.status = 'Running';
      document.started_at = new Date(this.clock).toISOString();
    } else if (action === 'stop') {
      document.status = 'Stopped';
    }
    return this.operation({});
  }

  private storage(method: IncusHttpMethod, [pool, volumes, , name, leaf]: readonly string[], json: () => Document): IncusTunnelResponse {
    if (volumes === undefined || method === 'GET' && name === undefined) {
      return sync(volumes === undefined ? { name: pool, driver: 'zfs', config: {} } : [...this.volumes.values()]);
    }
    if (name === undefined) {
      const created = json();
      const key = `${pool}/${String(created.name)}`;
      if (this.volumes.has(key)) return errorResponse(409, 'Volume already exists');
      this.volumes.set(key, {
        name: created.name,
        type: 'custom',
        content_type: 'filesystem',
        config: { ...(created.config as Document), 'volatile.uuid': randomUUID() },
        description: '',
      });
      return this.operation({});
    }
    const key = `${pool}/${name}`;
    const document = this.volumes.get(key);
    if (!document) return errorResponse(404, 'Storage volume not found');
    if (leaf === 'state') return sync({ usage: { used: 4096, total: Number((document.config as Document).size) } });
    switch (method) {
      case 'GET':
        return sync(document, etagOf(document));
      case 'DELETE':
        this.volumes.delete(key);
        return this.operation({});
      default: {
        const update = json();
        Object.assign(document, { config: update.config, description: update.description ?? '' });
        return sync({});
      }
    }
  }

  private image(method: IncusHttpMethod, [first, second]: readonly string[], json: () => Document): IncusTunnelResponse {
    if (first === 'aliases') {
      if (method === 'POST') {
        const alias = json();
        const image = this.images.get(String(alias.target));
        if (!image) return errorResponse(404, 'Image not found');
        (image.aliases as Document[]).push({ name: alias.name, description: '' });
        return sync({});
      }
      for (const image of this.images.values()) {
        const aliases = image.aliases as Document[];
        const index = aliases.findIndex((alias) => alias.name === second);
        if (index >= 0) {
          aliases.splice(index, 1);
          return sync({});
        }
      }
      return errorResponse(404, 'Image alias not found');
    }
    if (first === undefined) {
      if (method === 'GET') return sync([...this.images.values()]);
      const source = json().source as Document;
      const fingerprint = String(source.fingerprint ?? createHash('sha256').update(String(source.alias)).digest('hex'));
      this.images.set(fingerprint, {
        fingerprint,
        type: source.image_type ?? 'container',
        aliases: [],
        properties: {},
        update_source: { alias: source.alias, server: source.server, protocol: source.protocol },
      });
      return this.operation({ fingerprint });
    }
    const image = this.images.get(first);
    if (!image) return errorResponse(404, 'Image not found');
    if (method === 'GET') return sync(image, etagOf(image));
    this.images.delete(first);
    return this.operation({});
  }
}
