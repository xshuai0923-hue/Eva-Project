import test from 'node:test';
import assert from 'node:assert/strict';
import { creationRequestId } from './assets/create-form.js';

test('creation identifiers support HTTP LAN browsers without randomUUID', () => {
  const value = creationRequestId({ getRandomValues: bytes => bytes.fill(255) });
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
