import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const MAX_FRAME_BYTES = 1024 * 1024;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readSecret(name) {
  const value = readFileSync(required(name), 'utf8');
  if (!/^[A-Za-z0-9_-]{32,1024}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function sameSecret(actual, expected) {
  const left = Buffer.from(actual ?? '');
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readJson(name) {
  return JSON.parse(readFileSync(required(name), 'utf8'));
}

const tlsKey = readFileSync(required('CONTROL_TLS_KEY_FILE'));
const tlsCertificate = readFileSync(required('CONTROL_TLS_CERT_FILE'));
const adminToken = readSecret('CONTROL_ADMIN_TOKEN_FILE');
const tokens = {
  ssh: readSecret('SSH_PROXY_TOKEN_FILE'),
  http: readSecret('HTTP_PROXY_TOKEN_FILE'),
};
const snapshots = {
  ssh: { initial: readJson('SSH_INITIAL_SNAPSHOT_FILE'), revoked: readJson('SSH_REVOKED_SNAPSHOT_FILE') },
  http: { initial: readJson('HTTP_INITIAL_SNAPSHOT_FILE'), revoked: readJson('HTTP_REVOKED_SNAPSHOT_FILE') },
};
const paths = new Map([
  ['/ws/ssh-proxy', 'ssh'],
  ['/ws/http-proxy', 'http'],
]);
const sessions = { ssh: new Set(), http: new Set() };
let revoked = false;

function freshSnapshot(type) {
  const snapshot = structuredClone(snapshots[type][revoked ? 'revoked' : 'initial']);
  snapshot.validUntil = Date.now() + snapshot.staleAfterMs;
  return snapshot;
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME_BYTES) throw new Error('outbound WebSocket frame is too large');
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

class WebSocketPeer {
  constructor(type, socket, initialBytes) {
    this.type = type;
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.ackGeneration = 0;
    this.lastStatus = null;
    this.auditCount = 0;
    this.metricCount = 0;
    this.closed = false;
    sessions[type].add(this);
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
    if (initialBytes.length > 0) this.consume(initialBytes);
  }

  sendJson(kind, payload) {
    this.socket.write(encodeFrame(0x1, JSON.stringify({ kind, payload })));
  }

  sendSnapshot() {
    this.sendJson(revoked ? 'update' : 'snapshot', freshSnapshot(this.type));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    sessions[this.type].delete(this);
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      if ((first & 0x80) === 0) return this.socket.destroy(new Error('fragmented frames are unsupported'));
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if (!masked) return this.socket.destroy(new Error('client frame is not masked'));
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_FRAME_BYTES)) return this.socket.destroy(new Error('frame is too large'));
        length = Number(longLength);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) return this.socket.destroy(new Error('frame is too large'));
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      this.buffer = this.buffer.subarray(offset + 4 + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if (opcode === 0x8) {
        this.socket.end(encodeFrame(0x8, payload));
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode !== 0x1) continue;
      let message;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch {
        return this.socket.destroy(new Error('invalid JSON frame'));
      }
      if (message.kind === 'ack') this.ackGeneration = Number(message.payload?.generation ?? 0);
      if (message.kind === 'status') this.lastStatus = message;
      if (message.kind === 'audit') this.auditCount += 1;
      if (message.kind === 'metrics') this.metricCount += 1;
    }
  }
}

function stateFor(type) {
  const current = [...sessions[type]];
  return {
    connected: current.length > 0,
    connections: current.length,
    ackGeneration: Math.max(0, ...current.map((session) => session.ackGeneration)),
    activeConnections: Math.max(0, ...current.map((session) => Number(session.lastStatus?.payload?.activeConnections ?? 0))),
    auditCount: current.reduce((total, session) => total + session.auditCount, 0),
    metricCount: current.reduce((total, session) => total + session.metricCount, 0),
  };
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  response.end(body);
}

function adminAuthorized(request) {
  return sameSecret(request.headers['x-poc-admin'], adminToken);
}

const server = createServer({ key: tlsKey, cert: tlsCertificate }, (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (!adminAuthorized(request)) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method === 'GET' && request.url === '/admin/state') {
    sendJson(response, 200, { revoked, ssh: stateFor('ssh'), http: stateFor('http') });
    return;
  }
  if (request.method === 'POST' && request.url === '/admin/revoke') {
    revoked = true;
    for (const type of ['ssh', 'http']) {
      for (const session of sessions[type]) session.sendSnapshot();
    }
    sendJson(response, 200, { ok: true, revoked: true });
    return;
  }
  sendJson(response, 404, { error: 'not_found' });
});

server.on('upgrade', (request, socket, head) => {
  const type = paths.get(request.url ?? '');
  const expectedAuthorization = type ? `Bearer ${tokens[type]}` : '';
  const key = request.headers['sec-websocket-key'];
  const connection = request.headers.connection ?? '';
  const valid = type
    && sameSecret(request.headers.authorization, expectedAuthorization)
    && request.headers.upgrade?.toLowerCase() === 'websocket'
    && connection.split(',').some((token) => token.trim().toLowerCase() === 'upgrade')
    && request.headers['sec-websocket-version'] === '13'
    && typeof key === 'string';
  if (!valid) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
  const peer = new WebSocketPeer(type, socket, head);
  peer.sendSnapshot();
});

server.listen(8443, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'control_ready', port: 8443 }));
});
