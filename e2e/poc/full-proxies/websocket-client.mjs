import WebSocket from '../../../packages/backend/node_modules/ws/wrapper.mjs';

const [url, host, marker] = process.argv.slice(2);
if (!url || !host || !marker) throw new Error('usage: websocket-client.mjs <url> <host> <marker>');

let echoed = false;
let closed = false;
const socket = new WebSocket(url, { headers: { Host: host } });
const timer = setTimeout(() => {
  if (!closed) {
    console.error('TIMEOUT');
    socket.terminate();
    process.exitCode = 1;
  }
}, 20_000);

socket.on('open', () => socket.send(marker));
socket.on('message', (value) => {
  if (value.toString() !== `echo:${marker}`) {
    console.error(`UNEXPECTED:${value.toString()}`);
    process.exitCode = 1;
    socket.terminate();
    return;
  }
  echoed = true;
  console.log(`ECHO:${value.toString()}`);
  console.log('READY');
});
socket.on('close', (code) => {
  closed = true;
  clearTimeout(timer);
  console.log(`CLOSED:${code}`);
  if (!echoed) process.exitCode = 1;
});
socket.on('error', (error) => {
  if (!echoed) {
    console.error(`ERROR:${error.message}`);
    process.exitCode = 1;
  }
});
