// Holds a signed-in session to the local instance, so a browser can be driven through it
// without ever being handed a token. The browser talks to this proxy; the proxy talks to
// OpenProject with the session cookie from the jar, and keeps whatever cookies OpenProject
// sets to itself. Listens on 127.0.0.1 only, and refuses any upstream but the local one.
//
// usage: node session-proxy.mjs <cookie jar written by curl -c> [port] [upstream]
import http from 'node:http';
import { readFileSync } from 'node:fs';

const [jarPath, port = '28090', upstream = 'http://localhost:28080'] = process.argv.slice(2);
const target = new URL(upstream);
if (!jarPath || !['localhost', '127.0.0.1'].includes(target.hostname)) {
  console.error('usage: session-proxy.mjs <jar> [port] [upstream]; upstream must be the local instance');
  process.exit(2);
}
const self = `http://127.0.0.1:${port}`;

// Netscape cookie jar format, as curl writes it. The autologin token is left out: the
// session it was exchanged for is all this proxy needs.
const jar = new Map();
for (const line of readFileSync(jarPath, 'utf8').split('\n')) {
  const entry = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
  if (!entry || entry.startsWith('#')) continue;
  const fields = entry.split('\t');
  if (fields.length >= 7 && fields[5] !== 'autologin') jar.set(fields[5], fields[6]);
}

http.createServer((request, response) => {
  const headers = {
    ...request.headers,
    host: target.host,
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  };
  if (headers.origin) headers.origin = target.origin;
  if (headers.referer) headers.referer = headers.referer.replace(self, target.origin);
  delete headers['accept-encoding'];
  const outbound = http.request({
    hostname: target.hostname, port: target.port, method: request.method, path: request.url, headers
  }, answer => {
    const out = { ...answer.headers };
    for (const cookie of [].concat(out['set-cookie'] ?? [])) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      if (name && name !== 'autologin') jar.set(name, pair.slice(at + 1).trim());
    }
    delete out['set-cookie'];
    if (out.location) out.location = out.location.replace(target.origin, self);
    response.writeHead(answer.statusCode ?? 502, out);
    answer.pipe(response);
  });
  outbound.on('error', error => { response.writeHead(502); response.end(String(error)); });
  request.pipe(outbound);
}).listen(Number(port), '127.0.0.1', () => console.log(`session proxy on ${self} -> ${target.origin}`));
