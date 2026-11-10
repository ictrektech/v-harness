import assert from 'node:assert/strict';
import test from 'node:test';

import { IdentityGate, mayServe } from './identity-gate.mjs';

test('an idle session is not waiting for anything', async () => {
  const gate = new IdentityGate();
  assert.equal(await gate.wait('nobody'), 'idle');
  assert.equal(gate.armed('nobody'), false);
});

test('an armed navigation releases when the answer arrives', async () => {
  const gate = new IdentityGate({ waitMs: 500 });
  gate.arm('s1');
  const waiting = gate.wait('s1');
  gate.settle('s1', 'same');
  assert.equal(await waiting, 'same');
  assert.equal(gate.armed('s1'), false);
});

test('a switched account is reported to the waiting request', async () => {
  const gate = new IdentityGate({ waitMs: 500 });
  gate.arm('s2');
  setTimeout(() => { gate.settle('s2', 'switched'); }, 10);
  assert.equal(await gate.wait('s2'), 'switched');
  assert.equal(mayServe('switched'), false);
});

test('no answer inside the wait window reads as a timeout and stays serveable', async () => {
  const gate = new IdentityGate({ waitMs: 20, armMs: 1_000 });
  gate.arm('s3');
  assert.equal(await gate.wait('s3'), 'timeout');
  assert.equal(mayServe('timeout'), true);
});

test('a spent window does not make later requests wait again', async () => {
  const gate = new IdentityGate({ waitMs: 20, armMs: 1_000 });
  gate.arm('s6');
  assert.equal(await gate.wait('s6'), 'timeout');
  assert.equal(gate.armed('s6'), false);
  const started = Date.now();
  assert.equal(await gate.wait('s6'), 'idle');
  assert.ok(Date.now() - started < 15);
});

test('an unanswered navigation gives up on its own', async () => {
  const gate = new IdentityGate({ waitMs: 500, armMs: 10 });
  gate.arm('s4');
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(gate.armed('s4'), false);
});

test('arming twice keeps one answer', async () => {
  const gate = new IdentityGate({ waitMs: 500 });
  gate.arm('s5');
  gate.arm('s5');
  // The request that was already waiting is the one that receives the answer;
  // a request arriving afterwards finds nothing to wait for.
  const waiting = gate.wait('s5');
  gate.settle('s5', 'skipped');
  assert.equal(await waiting, 'skipped');
  assert.equal(gate.armed('s5'), false);
  assert.equal(await gate.wait('s5'), 'idle');
});

test('settling an idle session is a no-op', async () => {
  const gate = new IdentityGate();
  gate.settle('ghost', 'same');
  assert.equal(await gate.wait('ghost'), 'idle');
});
