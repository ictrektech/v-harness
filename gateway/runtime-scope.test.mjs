/**
 * Guard two failures that only surface on a real deployment.
 *
 * Both were observed on the 2026-11-11 image, and neither could be caught by
 * the existing suites: one lives in the browser script a tenant is served
 * (never executed by `node --test`), the other sits behind a `getuid() === 0`
 * branch that a developer workstation never enters.
 *
 * @module v-harness/gateway/runtime-scope.test
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const GATEWAY_DIR = fileURLToPath(new URL('.', import.meta.url));

test('the retry loop tests the error it captured, not the catch binding', async () => {
  const source = await readFile(join(GATEWAY_DIR, 'server.mjs'), 'utf8');
  // `catch (error) { last = error }` scopes `error` to the block. Reading it in
  // the loop body throws a ReferenceError before the retry decision is made, so
  // every failed exchange reached the page as "error is not defined" instead of
  // the portal's own reason.
  assert.ok(
    !source.includes('isPortalExpired(error))break'),
    'authorizeWithRetry must call isPortalExpired(last): the catch binding is out of scope there',
  );
});

test('a tenant hand-over passes numeric ids to chown', async () => {
  const source = await readFile(join(GATEWAY_DIR, 'capability-registry.mjs'), 'utf8');
  // fs.chown(path, uid, gid) rejects a group *name*; vh-userctl creates the
  // tenant group with `-g <uid>`, so the gid always equals the uid. Passing the
  // account string made every capability contract write fail with
  // `The "gid" argument must be of type number. Received type string`.
  assert.ok(
    !/chown\([^)]*account[^)]*\)/.test(source),
    'chown must receive a numeric gid (the tenant uid), never the account name',
  );
});
