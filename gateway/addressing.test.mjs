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
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { GATEWAY_IP, instanceAddress, tenantLoopback, tenantPacketMark } from './addressing.mjs';

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

test('tenantPacketMark encodes the uid under the bit docker leaves free', () => {
  assert.equal(tenantPacketMark(1), '0x40000001');
  assert.equal(tenantPacketMark(20_000), '0x40004e20');
  assert.equal(tenantPacketMark(65_535), '0x4000ffff');
  // Bit 30 stays clear of the marks docker puts on bridge traffic (0x80000).
  assert.equal(Number.parseInt(tenantPacketMark(20_000), 16) & 0x80000, 0);
});

test('tenantPacketMark refuses uids outside the encodable range', () => {
  assert.throws(() => tenantPacketMark(0));
  assert.throws(() => tenantPacketMark(-5));
  assert.throws(() => tenantPacketMark(65_536));
  assert.throws(() => tenantPacketMark(Number.NaN));
});

test('bin/vh-jail stamps exactly the mark this module matches', async () => {
  const source = await readFile(fileURLToPath(new URL('../bin/vh-jail', import.meta.url)), 'utf8');
  const expression = 'printf "0x%x" $(( 0x40000000 + VH_JAIL_UID ))';
  // A jail that stamps a different bit, or formats it differently, turns the
  // tenant boundary into a no-op: the chains stay empty while the policy is
  // "installed". The two sides are asserted rather than trusted.
  assert.ok(
    source.includes(expression),
    'bin/vh-jail no longer stamps the mark gateway/addressing.mjs computes',
  );
  for (const uid of [1, 20_000, 65_535]) {
    const shell = execFileSync('bash', ['-c', expression], {
      encoding: 'utf8',
      // The expression reads VH_JAIL_UID from the environment, so it has to be
      // set for the shell that evaluates it, not just for the command line.
      env: { ...process.env, VH_JAIL_UID: String(uid) },
    });
    assert.equal(shell, tenantPacketMark(uid));
  }
});
