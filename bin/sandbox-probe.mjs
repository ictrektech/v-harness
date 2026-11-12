#!/usr/bin/env node
/**
 * Report whether dsh's confinement chain can work in this container.
 *
 * dsh selects `bwrap` first, then the Landlock launcher, and confines with the
 * first rung that answers. bwrap confines by creating a user namespace, so a
 * host that denies one to an unprivileged uid has Landlock only — a fact about
 * the host, not about the code, which belongs in the container log rather than
 * in a support ticket.
 *
 * Exit code is always 0: this is a diagnosis, not a gate. Read `verdict`.
 *
 * Scope: this container, with the credentials a tenant runs under. It is not
 * the tenant jail — `bin/vh-jail` verifies the backend inside the jail at every
 * instance launch. The credentials still matter, because a probe that keeps
 * container root's capabilities answers for a process no tenant ever becomes:
 * root holds CAP_SYS_ADMIN, which is exactly what makes bwrap look usable when
 * it is not.
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

/** The uid a tenant runs under: unprivileged, and the whole point of the probe. */
const TENANT_UID = 65_534;

/**
 * Run a probe with the credentials `bin/vh-jail` drops a tenant to.
 *
 * The capability drops are the contract: the jail starts dsh with an empty
 * bounding, inheritable and ambient set under no-new-privs, so a probe that
 * keeps root's capabilities measures a posture no tenant has.
 * @param {string} command
 * @param {string[]} args
 */
function runAsTenant(command, args) {
  if (process.getuid?.() !== 0) return run(command, args);
  return run('setpriv', [
    '--no-new-privs',
    '--bounding-set=-all',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    `--reuid=${TENANT_UID}`,
    `--regid=${TENANT_UID}`,
    '--clear-groups',
    command,
    ...args,
  ]);
}

/** bwrap needs an unprivileged user namespace, which a hardened host may refuse. */
function probeUserns() {
  return runAsTenant('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', 'true']);
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
// Both bwrap probes are reported: the pair is what names the failure. Root
// passing while the tenant fails is a host policy on unprivileged user
// namespaces, not a missing binary, and the two need different answers.
const bwrap = linux ? runAsTenant('bwrap', BWRAP_PROBE) : { ok: false, error: 'not-linux' };
const bwrapAsRoot = linux ? run('bwrap', BWRAP_PROBE) : { ok: false, error: 'not-linux' };
const userns = linux ? probeUserns() : { ok: false, error: 'not-linux' };
const landlockKernel = linux && kernelSupportsLandlock();

/**
 * - `bwrap`: full enforcement available to a tenant
 * - `landlock`: bwrap unavailable to a tenant, Landlock is dsh's fallback
 * - `blocked`: neither can confine; dsh fails closed and bash will not run
 */
let verdict;
if (bwrap.ok) verdict = 'bwrap';
else if (landlockKernel) verdict = 'landlock';
else verdict = 'blocked';

const report = {
  platform: platform(),
  kernel: release(),
  scope: 'tenant credentials in this container; the jail is verified by bin/vh-jail',
  verdict,
  bwrap,
  bwrapAsRoot,
  userns,
  landlock: { kernelSupported: landlockKernel, lsm: lsmState() },
  note: verdict === 'landlock'
    ? 'bwrap cannot confine for a tenant on this host; dsh confines with Landlock instead, which is weaker (an older ABI cannot restrict reads).'
    : verdict === 'blocked'
      ? 'No confinement layer is available to a tenant; dsh fails closed and its bash tool will refuse to run.'
      : undefined,
  remediation: verdict === 'bwrap' ? undefined
    : 'Set kernel.apparmor_restrict_unprivileged_userns=0 on the host to give tenants the user namespace bwrap needs; no image change is involved.',
};

console.log(JSON.stringify(report, null, 2));
