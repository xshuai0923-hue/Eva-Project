import { createHash, randomBytes } from 'node:crypto';

type Request = { code: string; client: string; expires: number; login?: string };
export class AgentConnections {
  private requests = new Map<string, Request>();
  constructor(private now = () => Date.now(), private ttl = 10 * 60_000, private capacity = 256) {}
  private key(secret: string) { return createHash('sha256').update(secret).digest('hex'); }
  private prune() { for (const [key, value] of this.requests) if (value.expires <= this.now()) this.requests.delete(key); }
  start(client: string) {
    this.prune();
    if (this.requests.size >= this.capacity) throw new Error('Too many pending connections; try again later.');
    const secret = randomBytes(32).toString('hex');
    let code: string;
    do { code = randomBytes(6).toString('hex').toUpperCase(); } while ([...this.requests.values()].some(r => r.code === code));
    const request = { code, client: client.slice(0, 80), expires: this.now() + this.ttl };
    this.requests.set(this.key(secret), request);
    return { device_code: secret, user_code: code, expires_in: Math.floor(this.ttl / 1000), interval: 3 };
  }
  inspect(code: string) {
    this.prune();
    const request = [...this.requests.values()].find(r => r.code === code);
    if (!request) return null;
    return { code: request.code, client: request.client, expiresAt: new Date(request.expires).toISOString(), approved: !!request.login };
  }
  approve(code: string, login: string) {
    this.prune();
    const request = [...this.requests.values()].find(r => r.code === code);
    if (!request || request.login) return false;
    request.login = login;
    return true;
  }
  deny(code: string) {
    this.prune();
    for (const [key, request] of this.requests) if (request.code === code && !request.login) { this.requests.delete(key); return true; }
    return false;
  }
  poll(secret: string, tokenForLogin: (login: string) => string | null) {
    this.prune();
    const key = this.key(secret), request = this.requests.get(key);
    if (!request) return { status: 'expired' as const };
    if (!request.login) return { status: 'pending' as const };
    this.requests.delete(key);
    const token = tokenForLogin(request.login);
    return token ? { status: 'connected' as const, token } : { status: 'revoked' as const };
  }
}
