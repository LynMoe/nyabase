import { isIP } from 'node:net';
import {
  GUEST_IPV6_DISABLE_SYSCTLS,
  isForbiddenContainerMountPath,
  MANAGED_ATTACHMENT_DEVICE_PATTERN,
  MANAGED_INSTANCE_NAME_PATTERN,
  MANAGED_NIC_HOST_NAME_PATTERN,
  MANAGED_VOLUME_NAME_PATTERN,
  type AgentIncusHttpMethod,
} from '@nyabase/common';
import {
  IMAGE_ALIAS_FIELDS,
  IMAGE_PULL_FIELDS,
  IMAGE_SOURCE_FIELDS,
  INSTANCE_CREATE_FIELDS,
  INSTANCE_EXEC_FIELDS,
  INSTANCE_RENAME_FIELDS,
  INSTANCE_SOURCE_FIELDS,
  INSTANCE_STATE_FIELDS,
  INSTANCE_UPDATE_FIELDS,
  VOLUME_CREATE_FIELDS,
  VOLUME_UPDATE_FIELDS,
  fieldsProblem,
  isRecord,
  jsonBody,
  serialize,
  type FieldSchema,
} from './policy-body.js';
import type { OperationLookup } from './operation-ledger.js';

/*
 * What the Backend may ask the local Incus to do. The agent is the boundary:
 * even a compromised Backend can only manage nyabase instances and volumes as
 * unprivileged, uid-isolated, profile-free containers without host paths,
 * raw LXC config or IPv6. Anything not listed here is refused.
 */

export type PolicyVerdict =
  | {
    readonly allowed: true;
    /**
     * The only body the agent forwards; absent means none. JSON bodies are
     * re-serialized from the checked object (see policy-body.ts), with
     * volatile.* keys forced back to what Incus holds.
     */
    readonly body?: Buffer;
    /**
     * The request brings a guest NIC up (a start, or a NIC added or changed on
     * an instance that is not stopped): the agent forwards it only while the
     * IPv6 guard is verified in place.
     */
    readonly needsIpv6Guard?: boolean;
  }
  | {
    readonly allowed: false;
    readonly reason: string;
    /** Answer as Incus answers a resource that does not exist (an operation the agent did not start). */
    readonly notFound?: boolean;
  };

export interface PolicyRequest {
  readonly method: AgentIncusHttpMethod;
  readonly path: string;
  readonly body?: Buffer;
}

/** Reads the current Incus document (instance, volume) for volatile-key comparison. */
export type CurrentDocumentReader = (path: string) => Promise<Record<string, unknown> | undefined>;

/** What the policy needs besides the request itself. */
export interface PolicyContext {
  readonly readCurrent: CurrentDocumentReader;
  /** Operations started through this policy (operation-ledger.ts); no other operation is reachable. */
  readonly operations: OperationLookup;
}

const ALLOW: PolicyVerdict = { allowed: true };
const deny = (reason: string): PolicyVerdict => ({ allowed: false, reason });
const forward = (body: Record<string, unknown>, needsIpv6Guard = false): PolicyVerdict => (
  needsIpv6Guard
    ? { allowed: true, body: serialize(body), needsIpv6Guard }
    : { allowed: true, body: serialize(body) }
);

const PROBE_INSTANCE_PATTERN = /^nyabase-preflight-[0-9a-f]{32}$/;
const IMAGE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const OPERATION_ID_PATTERN = /^[0-9a-f-]{36}$/;
const ALLOWED_QUERY_KEYS = new Set(['recursion', 'path', 'timeout', 'secret', 'project']);
const POWER_ACTIONS = new Set(['start', 'stop', 'restart', 'freeze', 'unfreeze']);
/** Power actions after which guest NICs pass traffic again. */
const NIC_UP_ACTIONS = new Set(['start', 'restart', 'unfreeze']);
const CPUSET_PATTERN = /^\d+-\d+(?:,\d+-\d+)*$|^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)+$/;
const BOOLEAN_VALUES = new Set(['true', 'false']);

interface ParsedPath {
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
}

/**
 * Split and decode an Incus API path; refuses traversal and encoded separators
 * outside aliases. The agent forwards the path as given, so a second `?`
 * (whose tail Incus would read as query but a split here would drop) is refused.
 */
export function parseIncusPath(path: string): ParsedPath | undefined {
  const [rawPath = '', rawQuery = '', ...extra] = path.split('?');
  if (
    extra.length > 0
    || !rawPath.startsWith('/1.0')
    || /[\u0000-\u001f\u007f\\#]/.test(path)
    || /%2e|%5c|%00/i.test(rawPath)
    || rawPath.split('/').some((segment) => segment === '.' || segment === '..')
    || rawPath.includes('//')
  ) {
    return undefined;
  }
  let segments: string[];
  try {
    segments = rawPath.split('/').slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  const query = new URLSearchParams(rawQuery);
  for (const [key, value] of query) {
    if (!ALLOWED_QUERY_KEYS.has(key)) return undefined;
    if (key === 'project' && value !== 'default') return undefined;
  }
  return { segments, query };
}

function isManagedInstance(name: string | undefined): boolean {
  return name !== undefined && (MANAGED_INSTANCE_NAME_PATTERN.test(name) || PROBE_INSTANCE_PATTERN.test(name));
}

export async function checkIncusHttp(request: PolicyRequest, context: PolicyContext): Promise<PolicyVerdict> {
  const { readCurrent } = context;
  const parsed = parseIncusPath(request.path);
  if (!parsed) return deny('path is malformed or uses a refused query parameter');
  const [, collection, ...rest] = parsed.segments;
  if (parsed.segments[0] !== '1.0') return deny('only the 1.0 API is reachable');
  if (collection === undefined) {
    return request.method === 'GET' ? ALLOW : deny('server configuration is read-only');
  }
  switch (collection) {
    case 'resources':
      return request.method === 'GET' && rest.length === 0 ? ALLOW : deny('resources are read-only');
    case 'networks':
      return request.method === 'GET' && rest.length <= 2 && (rest.length < 2 || rest[1] === 'state')
        ? ALLOW
        : deny('networks are read-only');
    case 'instances':
      return checkInstances(request, rest, readCurrent);
    case 'storage-pools':
      return checkStoragePools(request, rest, readCurrent);
    case 'images':
      return checkImages(request, rest);
    case 'operations':
      return checkOperations(request.method, rest, context.operations);
    default:
      return deny(`/1.0/${collection} is not reachable through the agent`);
  }
}

export type WebSocketVerdict =
  /** `events`: the agent dials EVENTS_DIAL_PATH and relays only what filterIncusEvent keeps. */
  | { readonly allowed: true; readonly kind: 'events' | 'operation' }
  | { readonly allowed: false; readonly reason: string };

/** The only event stream the agent opens: lifecycle events (filtered), never logging or operations. */
export const EVENTS_DIAL_PATH = '/1.0/events?type=lifecycle';

/**
 * Incus WebSockets the Backend may open: the (filtered) event stream and the
 * channels of an operation this agent started (an exec or console it allowed).
 */
export function checkIncusWebSocket(path: string, operations: OperationLookup): WebSocketVerdict {
  const parsed = parseIncusPath(path);
  if (!parsed) return { allowed: false, reason: 'path is malformed' };
  const [version, collection, id, leaf] = parsed.segments;
  if (version !== '1.0') return { allowed: false, reason: 'only the 1.0 API is reachable' };
  if (collection === 'events' && parsed.segments.length === 2) return { allowed: true, kind: 'events' };
  if (
    collection === 'operations'
    && OPERATION_ID_PATTERN.test(id ?? '')
    && leaf === 'websocket'
    && parsed.segments.length === 4
    && parsed.query.has('secret')
  ) {
    return operations.knows(id!)
      ? { allowed: true, kind: 'operation' }
      : { allowed: false, reason: 'operation was not started through the agent' };
  }
  return { allowed: false, reason: 'only events and operation websockets are reachable' };
}

/**
 * The event the Backend may see, or undefined to drop it: lifecycle events of
 * nyabase instances and volumes only, reduced to what identifies them (the
 * Backend only wakes on them). Requestor, context and every event about the
 * host's other workloads stay on the host.
 */
export function filterIncusEvent(text: string): string | undefined {
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || event.type !== 'lifecycle' || !isRecord(event.metadata)) return undefined;
  const { action, source } = event.metadata;
  if (typeof action !== 'string' || typeof source !== 'string' || !isManagedSource(source)) return undefined;
  return JSON.stringify({
    type: 'lifecycle',
    timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
    metadata: { action, source },
  });
}

function isManagedSource(source: string): boolean {
  const segments = parseIncusPath(source)?.segments;
  if (!segments || segments[0] !== '1.0') return false;
  if (segments[1] === 'instances') return isManagedInstance(segments[2]);
  return segments[1] === 'storage-pools'
    && segments[3] === 'volumes'
    && segments[4] === 'custom'
    && MANAGED_VOLUME_NAME_PATTERN.test(segments[5] ?? '');
}

async function checkInstances(
  request: PolicyRequest,
  rest: readonly string[],
  readCurrent: CurrentDocumentReader,
): Promise<PolicyVerdict> {
  const { method } = request;
  if (rest.length === 0) {
    if (method === 'GET') return ALLOW;
    if (method !== 'POST') return deny('instance collection only supports list and create');
    return checkInstanceCreate(request.body);
  }
  const [name, leaf, ...tail] = rest;
  if (!isManagedInstance(name)) return deny('only nyabase instances are reachable');
  if (tail.length > 0) return deny('instance path is too deep');
  const instancePath = `/1.0/instances/${encodeURIComponent(name!)}`;
  if (leaf === undefined) {
    if (method === 'GET' || method === 'DELETE') return ALLOW;
    if (method === 'POST') {
      return checkJson(request.body, INSTANCE_RENAME_FIELDS, 'instance rename', (body) =>
        isManagedInstance(stringField(body, 'name'))
          ? forward(body)
          : deny('instances may only be renamed to another nyabase name'));
    }
    const body = jsonBody(request.body);
    if (!body) return deny('instance update needs a JSON body');
    const problem = fieldsProblem(body, INSTANCE_UPDATE_FIELDS, 'instance');
    if (problem) return deny(problem);
    const current = await readCurrent(instancePath);
    if (!current) return deny('instance to update does not exist');
    const verdict = checkInstanceDocument(body, { full: method === 'PUT' });
    if (!verdict.allowed) return verdict;
    return withCurrentVolatile(body, stringMap(current.config), bringsNicUp(body, current));
  }
  switch (leaf) {
    case 'state':
      if (method === 'GET') return ALLOW;
      if (method !== 'PUT') return deny('instance state only supports read and change');
      return checkJson(request.body, INSTANCE_STATE_FIELDS, 'instance state', (body) => {
        const action = String(body.action);
        return POWER_ACTIONS.has(action) ? forward(body, NIC_UP_ACTIONS.has(action)) : deny('unknown power action');
      });
    case 'exec':
      if (method !== 'POST') return deny('exec only supports POST');
      return checkJson(request.body, INSTANCE_EXEC_FIELDS, 'exec', (body) =>
        body.command === undefined ? deny('exec needs a command') : forward(body));
    case 'files':
      if (method === 'GET' || method === 'DELETE') return ALLOW;
      // File content is opaque bytes for Incus, not a document it decodes.
      return method === 'POST'
        ? { allowed: true, body: request.body }
        : deny('instance files support read, write and delete');
    default:
      return deny(`instance ${leaf} is not reachable through the agent`);
  }
}

function checkInstanceCreate(raw: Buffer | undefined): PolicyVerdict {
  const body = jsonBody(raw);
  if (!body) return deny('instance create needs a JSON body');
  const problem = fieldsProblem(body, INSTANCE_CREATE_FIELDS, 'instance');
  if (problem) return deny(problem);
  if (!isManagedInstance(stringField(body, 'name'))) return deny('only nyabase instances may be created');
  if (body.type !== undefined && body.type !== 'container') return deny('only containers may be created');
  const source = body.source;
  if (!isRecord(source) || source.type !== 'image') return deny('instances may only be created from an image');
  const sourceProblem = fieldsProblem(source, INSTANCE_SOURCE_FIELDS, 'instance source') ?? imageServerProblem(source);
  if (sourceProblem) return deny(sourceProblem);
  if (isRecord(body.config) && Object.keys(body.config).some((key) => key.startsWith('volatile.'))) {
    return deny('volatile keys may not be set on create');
  }
  const verdict = checkInstanceDocument(body, { full: true });
  return verdict.allowed ? forward(body, body.start === true) : verdict;
}

/**
 * Does an instance update plug a NIC into a live guest? Any NIC device that
 * differs from what the instance has now counts unless it is stopped.
 */
function bringsNicUp(body: Record<string, unknown>, current: Record<string, unknown>): boolean {
  if (!isRecord(body.devices) || String(current.status).toLowerCase() === 'stopped') return false;
  const before = isRecord(current.devices) ? current.devices : {};
  return Object.entries(body.devices).some(([name, device]) =>
    isRecord(device) && device.type === 'nic' && !sameStringMap(device, before[name]));
}

function sameStringMap(left: Record<string, unknown>, right: unknown): boolean {
  if (!isRecord(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => right[key] === left[key]);
}

/** Parse a JSON body, hold it to `schema`, then let `check` decide on the parsed object. */
function checkJson(
  raw: Buffer | undefined,
  schema: FieldSchema,
  label: string,
  check: (body: Record<string, unknown>) => PolicyVerdict,
): PolicyVerdict {
  const body = jsonBody(raw);
  if (!body) return deny(`${label} needs a JSON body`);
  const problem = fieldsProblem(body, schema, label);
  return problem ? deny(problem) : check(body);
}

interface DocumentCheckOptions {
  /** POST / PUT carry the whole document; PATCH carries a fragment. */
  readonly full: boolean;
}

/**
 * volatile.* belongs to Incus (idmaps, MACs, last state). An update may echo
 * it, but whatever it says is replaced with what Incus currently holds, so it
 * can never remap the container. A concurrent change still fails on the ETag.
 */
function withCurrentVolatile(
  body: Record<string, unknown>,
  current: Readonly<Record<string, string>>,
  needsIpv6Guard = false,
): PolicyVerdict {
  if (!isRecord(body.config)) return forward(body, needsIpv6Guard);
  const config = Object.fromEntries(
    Object.entries(body.config).flatMap(([key, value]): [string, unknown][] => {
      if (!key.startsWith('volatile.')) return [[key, value]];
      return Object.hasOwn(current, key) ? [[key, current[key]]] : [];
    }),
  );
  return forward({ ...body, config }, needsIpv6Guard);
}

export function checkInstanceDocument(
  body: Record<string, unknown>,
  options: DocumentCheckOptions,
): PolicyVerdict {
  if (body.profiles !== undefined || options.full) {
    if (!Array.isArray(body.profiles) || body.profiles.length !== 0) {
      return deny('instances must not use profiles');
    }
  }
  if (body.ephemeral === true) return deny('ephemeral instances are refused');
  if (body.stateful === true) return deny('stateful instances are refused');
  if (body.config !== undefined || options.full) {
    if (!isRecord(body.config)) return deny('instance config must be an object');
    const verdict = checkInstanceConfig(body.config, options);
    if (!verdict.allowed) return verdict;
  }
  if (body.devices !== undefined || options.full) {
    if (!isRecord(body.devices)) return deny('instance devices must be an object');
    for (const [name, device] of Object.entries(body.devices)) {
      const verdict = checkDevice(name, device);
      if (!verdict.allowed) return verdict;
    }
  }
  return ALLOW;
}

function checkInstanceConfig(
  config: Record<string, unknown>,
  options: DocumentCheckOptions,
): PolicyVerdict {
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string') return deny(`config ${key} must be a string`);
    const verdict = checkConfigEntry(key, value);
    if (!verdict.allowed) return verdict;
  }
  if (options.full) {
    if (config['security.idmap.isolated'] !== 'true') return deny('security.idmap.isolated must be true');
    if (config['security.privileged'] !== undefined && config['security.privileged'] !== 'false') {
      return deny('privileged containers are refused');
    }
  }
  return ALLOW;
}

function checkConfigEntry(key: string, value: string): PolicyVerdict {
  if (key.startsWith('volatile.')) return ALLOW;
  if (key.startsWith('user.nyabase.') || key.startsWith('image.')) return ALLOW;
  switch (key) {
    case 'limits.cpu':
      return CPUSET_PATTERN.test(value) ? ALLOW : deny('limits.cpu must be an explicit CPU set');
    case 'limits.memory':
    case 'limits.processes':
      return /^[0-9]+(?:[KMGT]i?B)?$/.test(value) ? ALLOW : deny(`${key} is malformed`);
    case 'security.privileged':
      return value === 'false' ? ALLOW : deny('privileged containers are refused');
    case 'security.idmap.isolated':
      return value === 'true' ? ALLOW : deny('security.idmap.isolated must be true');
    case 'security.nesting':
    case 'security.syscalls.intercept.mknod':
    case 'security.syscalls.intercept.setxattr':
    case 'nvidia.runtime':
      return BOOLEAN_VALUES.has(value) ? ALLOW : deny(`${key} must be a boolean`);
    default:
      if ((GUEST_IPV6_DISABLE_SYSCTLS as readonly string[]).includes(key)) {
        return value === '1' ? ALLOW : deny(`${key} must be 1`);
      }
      return deny(`config ${key} is not allowed`);
  }
}

const DISK_KEYS = new Set(['type', 'path', 'pool', 'source', 'size', 'readonly', 'limits.read', 'limits.write']);
const NIC_KEYS = new Set([
  'type', 'nictype', 'parent', 'name', 'hwaddr', 'host_name', 'ipv4.address',
  'security.ipv4_filtering', 'security.mac_filtering', 'security.port_isolation',
  'limits.ingress', 'limits.egress',
]);
const GPU_KEYS = new Set(['type', 'gputype', 'pci']);

export function checkDevice(name: string, device: unknown): PolicyVerdict {
  if (!isRecord(device)) return deny(`device ${name} must be an object`);
  const entries = stringMap(device);
  if (Object.keys(entries).length !== Object.keys(device).length) {
    return deny(`device ${name} values must be strings`);
  }
  switch (entries.type) {
    case 'disk':
      return checkDisk(name, entries);
    case 'nic':
      return checkNic(name, entries);
    case 'gpu':
      if (!/^gpu[0-9]+$/.test(name)) return deny(`gpu device ${name} is misnamed`);
      if (!onlyKeys(entries, GPU_KEYS)) return deny(`gpu device ${name} has refused keys`);
      return entries.gputype === 'physical' && /^[0-9a-f:.]{7,16}$/i.test(entries.pci ?? '')
        ? ALLOW
        : deny(`gpu device ${name} must be a physical card by PCI address`);
    default:
      return deny(`device ${name} of type ${entries.type ?? 'none'} is not allowed`);
  }
}

function checkDisk(name: string, device: Readonly<Record<string, string>>): PolicyVerdict {
  if (!onlyKeys(device, DISK_KEYS)) return deny(`disk ${name} has refused keys`);
  if (!device.pool) return deny(`disk ${name} must live in a storage pool`);
  if (name === 'root') {
    return device.path === '/' && device.source === undefined ? ALLOW : deny('root disk is malformed');
  }
  if (!MANAGED_ATTACHMENT_DEVICE_PATTERN.test(name)) return deny(`disk ${name} is not a nyabase attachment`);
  if (!MANAGED_VOLUME_NAME_PATTERN.test(device.source ?? '')) return deny(`disk ${name} must mount a nyabase volume`);
  const path = device.path ?? '';
  if (
    !path.startsWith('/')
    || path === '/'
    || /[\u0000-\u001f\u007f]/.test(path)
    || path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return deny(`disk ${name} path is malformed`);
  }
  // A writable volume over a kernel pseudo-filesystem is a runtime escape vector.
  if (isForbiddenContainerMountPath(path)) return deny(`disk ${name} must not be mounted under /proc, /sys or /dev`);
  return ALLOW;
}

function checkNic(name: string, device: Readonly<Record<string, string>>): PolicyVerdict {
  if (name !== 'eth0') return deny('the only NIC is eth0');
  if (!onlyKeys(device, NIC_KEYS)) return deny('eth0 has refused keys');
  if (device.nictype !== 'bridged' || !device.parent) return deny('eth0 must be a bridged NIC');
  if (!MANAGED_NIC_HOST_NAME_PATTERN.test(device.host_name ?? '')) {
    return deny('eth0 host_name must carry the IPv6 guard prefix');
  }
  if (device['security.ipv4_filtering'] !== 'true' || device['security.mac_filtering'] !== 'true') {
    return deny('eth0 must filter IPv4 and MAC spoofing');
  }
  if (!device['ipv4.address']) return deny('eth0 needs its IPv4 filter identity');
  return ALLOW;
}

async function checkStoragePools(
  request: PolicyRequest,
  rest: readonly string[],
  readCurrent: CurrentDocumentReader,
): Promise<PolicyVerdict> {
  const { method } = request;
  if (method === 'GET') return rest.length <= 5 ? ALLOW : deny('storage path is too deep');
  const [pool, volumes, type, name, ...tail] = rest;
  if (!pool || volumes !== 'volumes' || tail.length > 0) return deny('storage pools are read-only');
  if (type === undefined || (type === 'custom' && name === undefined)) {
    if (method !== 'POST') return deny('volume collection only supports create');
    const body = jsonBody(request.body);
    if (!body) return deny('volume create needs a JSON body');
    const problem = fieldsProblem(body, VOLUME_CREATE_FIELDS, 'volume');
    if (problem) return deny(problem);
    if (!MANAGED_VOLUME_NAME_PATTERN.test(stringField(body, 'name') ?? '')) {
      return deny('only nyabase volumes may be created');
    }
    if ((body.type ?? 'custom') !== 'custom') return deny('only custom volumes may be created');
    if ((body.content_type ?? 'filesystem') !== 'filesystem') return deny('only filesystem volumes may be created');
    if (isRecord(body.config) && Object.keys(body.config).some((key) => key.startsWith('volatile.'))) {
      return deny('volatile keys may not be set on create');
    }
    const verdict = checkVolumeConfig(body.config ?? {});
    return verdict.allowed ? forward(body) : verdict;
  }
  if (type !== 'custom' || !MANAGED_VOLUME_NAME_PATTERN.test(name ?? '')) {
    return deny('only nyabase custom volumes are writable');
  }
  if (method === 'DELETE') return ALLOW;
  if (method !== 'PUT' && method !== 'PATCH') return deny('volumes support update and delete');
  const body = jsonBody(request.body);
  if (!body) return deny('volume update needs a JSON body');
  const problem = fieldsProblem(body, VOLUME_UPDATE_FIELDS, 'volume');
  if (problem) return deny(problem);
  const current = await readCurrent(
    `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name!)}`,
  );
  if (!current) return deny('volume to update does not exist');
  // PUT replaces the whole config: leaving security.shifted out would drop it.
  if (method === 'PUT' && (!isRecord(body.config) || body.config['security.shifted'] !== 'true')) {
    return deny('volumes must stay shifted');
  }
  const verdict = checkVolumeConfig(body.config ?? {});
  if (!verdict.allowed) return verdict;
  return withCurrentVolatile(body, stringMap(current.config));
}

function checkVolumeConfig(config: unknown): PolicyVerdict {
  if (!isRecord(config)) return deny('volume config must be an object');
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string') return deny(`volume config ${key} must be a string`);
    if (key.startsWith('volatile.')) continue;
    if (key === 'security.shifted') {
      if (value !== 'true') return deny('volumes must stay shifted');
      continue;
    }
    if (key === 'size' || key.startsWith('block.') || key.startsWith('initial.')) continue;
    // Ownership labels: inert to Incus, they let the Backend tell its volumes apart.
    if (key.startsWith('user.nyabase.')) continue;
    return deny(`volume config ${key} is not allowed`);
  }
  return ALLOW;
}

function checkImages(request: PolicyRequest, rest: readonly string[]): PolicyVerdict {
  const { method } = request;
  if (method === 'GET') return ALLOW;
  if (rest[0] === 'aliases') {
    if (rest.length === 1 && method === 'POST') {
      return checkJson(request.body, IMAGE_ALIAS_FIELDS, 'image alias', (body) =>
        typeof body.name === 'string' && typeof body.target === 'string'
          ? forward(body)
          : deny('an image alias needs a name and a target'));
    }
    return rest.length === 2 && method === 'DELETE' ? ALLOW : deny('image aliases support create and delete');
  }
  if (rest.length === 0) {
    if (method !== 'POST') return deny('image collection only supports remote pulls');
    return checkJson(request.body, IMAGE_PULL_FIELDS, 'image', (body) => {
      const source = body.source;
      if (!isRecord(source) || source.type !== 'image' || typeof source.server !== 'string') {
        return deny('images may only be pulled from a remote image server');
      }
      const problem = fieldsProblem(source, IMAGE_SOURCE_FIELDS, 'image source') ?? imageServerProblem(source);
      return problem ? deny(problem) : forward(body);
    });
  }
  if (rest.length !== 1 || !IMAGE_FINGERPRINT_PATTERN.test(rest[0]!)) return deny('image path is malformed');
  return method === 'DELETE' ? ALLOW : deny('images support read and delete');
}

/**
 * Incus fetches from a remote image server itself, from the host's network:
 * without this a compromised Backend could point it at anything the host can
 * reach. Only simplestreams over https to a public DNS name is allowed; IP
 * literals (in any spelling the URL parser accepts) and local-only names are
 * refused. A name that resolves to a private address is not caught here.
 */
export function imageServerProblem(source: Record<string, unknown>): string | undefined {
  if (source.server === undefined) return undefined;
  if (typeof source.server !== 'string') return 'image source server must be a string';
  if (source.protocol !== 'simplestreams') return 'remote images must use the simplestreams protocol';
  let url: URL;
  try {
    url = new URL(source.server);
  } catch {
    return 'image source server must be a URL';
  }
  if (url.protocol !== 'https:') return 'image source server must use https';
  if (url.username || url.password) return 'image source server must not carry credentials';
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(host) !== 0) return 'image source server must be a DNS name, not an IP address';
  if (
    !host.includes('.')
    || host === 'localhost'
    || LOCAL_ONLY_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return 'image source server must be a public host';
  }
  return undefined;
}

const LOCAL_ONLY_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

/**
 * Only operations this agent started are reachable, and only to read and wait
 * on them (the Backend never lists or cancels operations). Any other id is
 * answered as Incus answers one that does not exist.
 */
function checkOperations(
  method: AgentIncusHttpMethod,
  rest: readonly string[],
  operations: OperationLookup,
): PolicyVerdict {
  const [id, leaf, ...tail] = rest;
  if (method !== 'GET' || id === undefined) return deny('operations support read and wait');
  if (!OPERATION_ID_PATTERN.test(id) || (leaf !== undefined && leaf !== 'wait') || tail.length > 0) {
    return deny('operation path is malformed');
  }
  return operations.knows(id)
    ? ALLOW
    : { allowed: false, reason: 'operation was not started through the agent', notFound: true };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function onlyKeys(record: Readonly<Record<string, string>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}
