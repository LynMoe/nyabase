import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_FRAME_BYTES = 1024 * 1024;

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length >= 126) throw new Error('PoC workload only emits small frames');
  return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
}

function attachEcho(socket, initialBytes) {
  let buffer = Buffer.from(initialBytes);
  function consume(chunk = Buffer.alloc(0)) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      if ((first & 0x80) === 0 || (second & 0x80) === 0) return socket.destroy();
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const longLength = buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_FRAME_BYTES)) return socket.destroy();
        length = Number(longLength);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES || buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      buffer = buffer.subarray(offset + 4 + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if (opcode === 0x8) return socket.end(encodeFrame(0x8, payload));
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode === 0x1) socket.write(encodeFrame(0x1, `echo:${payload.toString('utf8')}`));
    }
  }
  socket.on('data', consume);
  if (buffer.length > 0) consume();
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/hello') {
    const body = `${JSON.stringify({ ok: true, marker: 'nyabase-http-poc' })}\n`;
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    });
    response.end(body);
    return;
  }
  response.writeHead(404, { 'content-length': 0, connection: 'close' });
  response.end();
});

server.on('upgrade', (request, socket, head) => {
  const key = request.headers['sec-websocket-key'];
  const valid = request.url === '/socket'
    && request.headers.upgrade?.toLowerCase() === 'websocket'
    && request.headers.connection?.toLowerCase().split(',').some((token) => token.trim() === 'upgrade')
    && request.headers['sec-websocket-version'] === '13'
    && typeof key === 'string';
  if (!valid) return socket.destroy();
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
  attachEcho(socket, head);
});

server.listen(8080, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'http_workload_ready', port: 8080 }));
});
