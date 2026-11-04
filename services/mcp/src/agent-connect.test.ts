import { describe, it, expect } from 'vitest';
import { AgentConnections } from './agent-connect.js';
describe('browser-approved Agent connections', () => {
  it('requires approval and the device secret, and returns a token once', () => {
    const pairs = new AgentConnections(); const p = pairs.start('Codex');
    expect(pairs.poll(p.device_code, () => 'secret')).toEqual({ status: 'pending' });
    expect(pairs.poll(p.user_code, () => 'secret')).toEqual({ status: 'expired' });
    expect(pairs.approve(p.user_code, 'alice')).toBe(true);
    expect(pairs.approve(p.user_code, 'bob')).toBe(false);
    const inspected = pairs.inspect(p.user_code)!;
    expect(Object.keys(inspected).sort()).toEqual(['approved', 'client', 'code', 'expiresAt']);
    expect(pairs.poll(p.device_code, login => login === 'alice' ? 'alice-token' : null)).toEqual({ status: 'connected', token: 'alice-token' });
    expect(pairs.poll(p.device_code, () => 'secret')).toEqual({ status: 'expired' });
  });
  it('expires approvals and refuses revoked accounts at collection time', () => {
    let now = 0; const pairs = new AgentConnections(() => now, 1000);
    const p = pairs.start('Claude Code'); pairs.approve(p.user_code, 'alice');
    expect(pairs.poll(p.device_code, () => null)).toEqual({ status: 'revoked' });
    const q = pairs.start('Codex'); now = 1001;
    expect(pairs.inspect(q.user_code)).toBeNull(); expect(pairs.approve(q.user_code, 'alice')).toBe(false);
    expect(pairs.poll(q.device_code, () => 'secret')).toEqual({ status: 'expired' });
  });
  it('supports denial and limits pending requests', () => {
    const pairs = new AgentConnections(() => 0, 1000, 1); const p = pairs.start('Codex');
    expect(() => pairs.start('Codex')).toThrow(/Too many/);
    expect(pairs.deny(p.user_code)).toBe(true); expect(pairs.poll(p.device_code, () => 'secret')).toEqual({ status: 'expired' });
    expect(pairs.start('Codex').device_code).toHaveLength(64);
  });
});
