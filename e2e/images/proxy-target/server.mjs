import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const port = 8080;
const prefix = 'nyabase-real-proxy-target:';

const server = createServer((request, response) => {
  const body = `${prefix}${request.url ?? '/'}`;
  response.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  response.end(body);
});

server.on('upgrade', (request, socket, head) => {
  const key = request.headers['sec-websocket-key'];
  if (
    typeof key !== 'string'
    || request.headers.upgrade?.toLowerCase() !== 'websocket'
    || !String(request.headers.connection ?? '').toLowerCase().split(',').map((part) => part.trim()).includes('upgrade')
  ) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
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

  let pending = head;
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (!masked || length > 125) {
        socket.destroy();
        return;
      }
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(pending.subarray(offset, offset + length));
      pending = pending.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      if (opcode !== 0x1) {
        socket.destroy();
        return;
      }
      const echoed = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
      socket.write(echoed);
    }
  });
});

server.listen(port, '0.0.0.0');
