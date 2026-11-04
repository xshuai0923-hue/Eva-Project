import { createInterface } from 'node:readline';
import { EvaTransport, loadConnection } from './connection.mjs';
let transport;
try { transport = new EvaTransport(loadConnection()); }
catch { process.stderr.write('Eva connection is not configured. Run scripts/setup.mjs configure first.\n'); process.exit(1); }
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try { message = JSON.parse(line); }
  catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }) + '\n'); continue; }
  try {
    for (const response of await transport.send(message)) process.stdout.write(JSON.stringify(response) + '\n');
  } catch (error) {
    if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } }) + '\n');
    else process.stderr.write(error.message + '\n');
  }
}
