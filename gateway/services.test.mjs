/**
 * The line the panel offers as the reason a service died.
 *
 * After a replayed service exits immediately, the gateway reads its log back
 * and picks one line out of it. Picking the wrong line is worse than picking
 * none: the 2026-11 deployment showed `已登记` — a registration that succeeded —
 * as the cause of the exit, so the owner read a success message where the
 * failure reason belonged.
 *
 * @module v-harness/gateway/services.test
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { firstFailure } from './services.mjs';

test('names the line that carries the error', () => {
  const log = [
    'vh-service: 「坦克大战」已登记 (127.78.32.1:8081)，Ctrl-C 停止',
    'Error: listen EADDRINUSE: address already in use 127.78.32.1:8081',
  ].join('\n');
  assert.match(firstFailure(log) ?? '', /EADDRINUSE/u);
});

test('never hands the registration notice back as a failure', () => {
  assert.equal(firstFailure('vh-service: 「坦克大战」已登记 (127.78.32.1:8081)，Ctrl-C 停止'), undefined);
});

test('falls back to the first line that is not the registration notice', () => {
  const log = [
    'vh-service: 「坦克大战」已登记 (127.78.32.1:8081)，Ctrl-C 停止',
    "python3: can't open file '/home/vh-x/workspace/server.py': [Errno 2] No such file or directory",
  ].join('\n');
  assert.equal(
    firstFailure(log),
    "python3: can't open file '/home/vh-x/workspace/server.py': [Errno 2] No such file or directory",
  );
});

test('an empty log names nothing', () => {
  assert.equal(firstFailure(''), undefined);
  assert.equal(firstFailure('\n\n'), undefined);
});
