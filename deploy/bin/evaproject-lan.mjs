#!/usr/bin/env node
// A development-only LAN bridge; the Eva containers remain bound to loopback.
import { createServer, connect } from 'node:net';
import { networkInterfaces } from 'node:os';
const at = process.argv.indexOf('--host');
const host = at < 0 ? '' : process.argv[at + 1];
const privateV4 = value => /^10\./.test(value) || /^192\.168\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
if (!host || !privateV4(host) || !Object.values(networkInterfaces()).flat().some(a => a?.address === host && !a.internal)) {
  console.error('Pass --host with this machine\'s private LAN IPv4 address.');process.exit(1);
}
const sockets = new Set(), listeners = [];
for (const port of [28080, 28081]) {
  const server = createServer(client => {
    if (!privateV4(client.remoteAddress || '')) { client.destroy();return; }
    const upstream = connect({ host: '127.0.0.1', port });
    sockets.add(client);sockets.add(upstream);
    for (const socket of [client, upstream]) {
      socket.setTimeout(10 * 60_000);
      socket.on('timeout', () => socket.destroy());
      socket.on('error', () => { client.destroy();upstream.destroy(); });
      socket.on('close', () => { sockets.delete(socket);client.destroy();upstream.destroy(); });
    }
    client.pipe(upstream);upstream.pipe(client);
  });
  server.on('error', error => { console.error(`Eva LAN port ${port}: ${error.code}`);shutdown(1); });
  server.listen(port, host, () => console.log(`Eva LAN ${host}:${port} -> 127.0.0.1:${port}`));listeners.push(server);
}
function shutdown(code = 0) { for (const socket of sockets) socket.destroy();for (const listener of listeners) listener.close();process.exitCode = code; }
process.on('SIGINT', () => shutdown());process.on('SIGTERM', () => shutdown());
