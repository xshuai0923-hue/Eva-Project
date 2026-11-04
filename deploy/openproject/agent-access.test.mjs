import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPrompt } from './assets/agent-access.js';

test('the copied onboarding prompt targets the selected client and configured instance', () => {
  const input = { server: 'https://mcp.eva.example/mcp', archive: 'https://eva.example/evaproject/agent-plugin/eva-project.zip', sha256: 'a'.repeat(64), version: '0.1.0' };
  for (const client of ['codex', 'claude']) {
    const prompt = installPrompt({ ...input, client });
    assert.ok(prompt.includes(`install --client ${client}`));
    assert.ok(prompt.includes(`connect --server ${input.server} --client ${client}`));
    assert.ok(prompt.includes(input.archive)); assert.ok(prompt.includes(input.sha256));
    assert.equal(prompt.includes('localhost'), false);
  }
});

test('global guidance points each client to its own user-level instructions', async () => {
  const { globalGuidelinesLocation } = await import('./assets/agent-access.js');
  assert.equal(globalGuidelinesLocation('codex'), '~/.codex/AGENTS.md');
  assert.equal(globalGuidelinesLocation('claude'), '~/.claude/CLAUDE.md');
});

test('generic onboarding uses its own mode without registering a different client', () => {
  const prompt = installPrompt({ client: 'generic', server: 'https://eva.example/mcp', archive: 'https://eva.example/plugin.zip', sha256: 'a'.repeat(64), version: '0.1.3' });
  assert.ok(prompt.includes('install --client generic'));
  assert.ok(prompt.includes('connect --server https://eva.example/mcp --client generic'));
  assert.equal(prompt.includes('install --client codex'), false);
  assert.equal(prompt.includes('install --client claude'), false);
});
