/**
 * Session store tests: create/load round trip, UA binding, sliding expiry,
 * and both revocation paths. Each test uses its own temp database so the
 * WAL files never leak between cases.
 *
 * @module v-harness/gateway/session.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openSessionStore, parseCookies, csrfMatches, cookie } from './session.mjs';

const UA = 'Mozilla/5.0 vh-test';
const TTL_MS = 60 * 60 * 1_000;

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'vh-session-test-'));
  dirs.push(dir);
  return join(dir, 'sessions.db');
}

describe('session store', () => {
  it('round-trips a created session', async () => {
    const store = await openSessionStore(dbPath(), { ttlMs: TTL_MS });
    const sid = store.createSession({ subject: 'sub-1', account: 'tieniu', userAgent: UA }, 1_000);
    const session = store.loadSession(sid, UA, 2_000);
    assert.deepEqual(session, { sid, subject: 'sub-1', account: 'tieniu', expiresAt: 1_000 + TTL_MS });
  });

  it('refuses a session replayed from another browser (UA mismatch)', async () => {
    const store = await openSessionStore(dbPath(), { ttlMs: TTL_MS });
    const sid = store.createSession({ subject: 'sub-1', account: 'tieniu', userAgent: UA });
    assert.equal(store.loadSession(sid, 'Mozilla/5.0 other-browser'), undefined);
    // The original browser keeps working.
    assert.notEqual(store.loadSession(sid, UA), undefined);
  });

  it('refuses an expired session and slides the window on activity', async () => {
    const store = await openSessionStore(dbPath(), { ttlMs: TTL_MS });
    const sid = store.createSession({ subject: 'sub-1', account: 'a', userAgent: UA }, 0);
    assert.equal(store.loadSession(sid, UA, TTL_MS + 1), undefined);

    const sliding = await openSessionStore(dbPath(), { ttlMs: TTL_MS });
    const live = sliding.createSession({ subject: 'sub-2', account: 'b', userAgent: UA }, 0);
    // Activity just before expiry slides the window a full TTL forward.
    assert.notEqual(sliding.loadSession(live, UA, TTL_MS - 1), undefined);
    assert.equal(sliding.loadSession(live, UA, 2 * TTL_MS), undefined);
  });

  it('revokes one session by sid and every session by subject', async () => {
    const store = await openSessionStore(dbPath(), { ttlMs: TTL_MS });
    const kept = store.createSession({ subject: 'sub-1', account: 'a', userAgent: UA });
    const gone = store.createSession({ subject: 'sub-2', account: 'b', userAgent: UA });
    store.revokeSession(gone);
    assert.equal(store.loadSession(gone, UA), undefined);
    assert.notEqual(store.loadSession(kept, UA), undefined);

    store.revokeSubject('sub-1');
    assert.equal(store.loadSession(kept, UA), undefined);
  });

  it('records when a session proved its identity and forgets it on revoke', async () => {
    const store = await openSessionStore(dbPath(), { ttlMs: TTL_MS });
    const sid = store.createSession({ subject: 'sub-1', account: 'a', userAgent: UA });
    // Creating a session issues a ticket; only the bootstrap page can prove
    // which account holds it, so a fresh session has no proof yet.
    assert.equal(store.proofAge(sid, 5_000), undefined);

    store.prove(sid, 5_000);
    assert.equal(store.proofAge(sid, 5_000), 0);
    assert.equal(store.proofAge(sid, 9_000), 4_000);

    store.revokeSession(sid);
    assert.equal(store.proofAge(sid, 9_000), undefined, 'a revoked ticket carries no proof');
  });
});

describe('cookie helpers', () => {
  it('parses a Cookie header with encoded values', () => {
    assert.deepEqual(parseCookies('a=b%20c; d=e'), { a: 'b c', d: 'e' });
    assert.deepEqual(parseCookies(undefined), {});
  });

  it('compares CSRF tokens in constant time without throwing on short input', () => {
    assert.equal(csrfMatches('abc', 'abc'), true);
    assert.equal(csrfMatches('abc', 'abd'), false);
    assert.equal(csrfMatches(undefined, 'abc'), false);
  });

  it('serializes the session cookie attributes', () => {
    const line = cookie('vh_session', 's1', { maxAgeSeconds: 10, secure: true });
    assert.match(line, /^vh_session=s1;/);
    assert.match(line, /HttpOnly/);
    assert.match(line, /SameSite=Lax/);
    assert.match(line, /Secure/);
  });
});
