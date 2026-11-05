/**
 * The per-tenant loopback addressing: one 127/8 address per uid, stable for
 * the tenant's life, shared with the shell arithmetic in `bin/vh-jail` that
 * keys the iptables rules to the same address.
 *
 * Run: `node --test gateway/addressing.test.mjs`
 * @module v-harness/gateway/addressing.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GATEWAY_IP, instanceAddress, tenantLoopback } from './addressing.mjs';

test('tenantLoopback encodes the uid into the 127/8 range', () => {
  assert.equal(tenantLoopback(20_000), '127.78.32.1');
  assert.equal(tenantLoopback(20_001), '127.78.33.1');
  assert.equal(tenantLoopback(65_535), '127.255.255.1');
});

test('tenantLoopback never lands on the shared gateway address', () => {
  for (let uid = 1; uid <= 65_535; uid += 997) {
    assert.notEqual(tenantLoopback(uid), '127.0.0.1');
  }
});

test('tenantLoopback refuses uids outside the encodable range', () => {
  assert.throws(() => tenantLoopback(0));
  assert.throws(() => tenantLoopback(-5));
  assert.throws(() => tenantLoopback(65_536));
  assert.throws(() => tenantLoopback(Number.NaN));
});

test('instanceAddress dials the tenant address; the gateway stays on the shared loopback', () => {
  assert.equal(instanceAddress(20_000), '127.78.32.1');
  assert.equal(GATEWAY_IP, '127.0.0.1');
});
