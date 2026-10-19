#!/usr/bin/env node
/**
 * Report whether dsh's confinement chain can work in this container.
 *
 * dsh selects `bwrap` first, then the Landlock launcher, and fails closed when
 * neither can apply a profile: `bash` would refuse to run at all. That is a
 * startup-time fact about the host, not about the code, so it belongs in the
 * container log rather than in a support ticket.
 *
 * Exit code is always 0: this is a diagnosis, not a gate. Read `verdict`.
 *
 * @module v-harness/bin/sandbox-probe
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { release, platform } from 'node:os';

/** bwrap arguments dsh itself uses to decide whether bwrap can confine. */
const BWRAP_PROBE = [
  '--ro-bind', '/', '/',
  '--dev', '/dev',
  '--unshare-pid',
  '--proc', '/proc',
  '--die-with-parent',
  '--', 'true',
];

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, { timeout: 5_000, stdio: 'pipe', encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    error: result.error?.code ?? null,
    stderr: (result.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '',
  };
}

/** bwrap needs an unprivileged user namespace; Docker's seccomp often denies it. */
function probeUserns() {
  return run('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', 'true']);
}

/** Landlock landed in 5.13; the ABI version is what the launcher actually negotiates. */
function kernelSupportsLandlock() {
  const match = /^(\d+)\.(\d+)/.exec(release());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 5 || (major === 5 && minor >= 13);
}

/**
 * Best-effort LSM listing. securityfs is frequently unmounted inside
 * containers, so a missing file means "unknown", not "absent".
 */
function lsmState() {
  try {
    const text = readFileSync('/sys/kernel/security/lsm', 'utf8').trim();
    return text.length > 0 ? text : 'unknown';
  } catch {
    return 'unknown';
  }
}

const linux = platform() === 'linux';
const bwrap = linux ? run('bwrap', BWRAP_PROBE) : { ok: false, error: 'not-linux' };
const userns = linux ? probeUserns() : { ok: false, error: 'not-linux' };
const landlockKernel = linux && kernelSupportsLandlock();

/**
 * - `bwrap`: full enforcement available
 * - `landlock`: bwrap unavailable, Landlock is the expected fallback
 * - `blocked`: neither can confine; dsh fails closed and bash will not run
 * - `unverified`: kernel looks new enough but the launcher was not exercised
 */
let verdict;
if (bwrap.ok) verdict = 'bwrap';
else if (landlockKernel) verdict = 'landlock';
else verdict = 'blocked';

const report = {
  platform: platform(),
  kernel: release(),
  verdict,
  bwrap,
  userns,
  landlock: { kernelSupported: landlockKernel, lsm: lsmState() },
  note: verdict === 'landlock'
    ? 'bwrap unavailable; Landlock is expected to confine. Confirm with the first bash call: result.sandbox.enforcement should be "full".'
    : verdict === 'blocked'
      ? 'No confinement layer is available; dsh fails closed and the bash tool will refuse to run.'
      : undefined,
};

console.log(JSON.stringify(report, null, 2));
