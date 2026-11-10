/**
 * One navigation, one background answer about who is browsing.
 *
 * The gateway serves the shell without asking first — the shell is generic code
 * and carries no tenant data — and arms this gate instead. The page then proves
 * identity in the background and settles the gate; every data request that
 * arrives in between waits here, briefly, rather than being served from an
 * answer nobody has confirmed yet.
 *
 * The gate deliberately fails open on a timeout: a platform that cannot answer
 * must not cost the user their workspace. What it will not do is pass data
 * through *after* learning the answer changed — that outcome is terminal.
 *
 * @module v-harness/gateway/identity-gate
 */

/** How long one armed navigation waits for its answer before giving up. */
const DEFAULT_WAIT_MS = 1_200;

/** How long an armed navigation stays armed with no answer at all. */
const DEFAULT_ARM_MS = 5_000;

/**
 * Outcomes the browser can report for one navigation.
 *
 * - `same`     — the platform says the same account is signed in.
 * - `switched` — a different account is signed in; the session was replaced.
 * - `skipped`  — the platform could not answer (no bridge, outage, refusal).
 * - `timeout`  — nothing was reported before the wait expired.
 */
export const GATE_OUTCOMES = Object.freeze(['same', 'switched', 'skipped', 'timeout']);

export class IdentityGate {
  /** @type {Map<string, { promise: Promise<string>, resolve: (outcome: string) => void, timer: ReturnType<typeof setTimeout> }>} */
  #pending = new Map();

  /**
   * @param {{ waitMs?: number, armMs?: number }} [options] - `waitMs` bounds how
   *   long a data request blocks; `armMs` bounds how long an unanswered
   *   navigation stays armed.
   */
  constructor(options = {}) {
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.armMs = options.armMs ?? DEFAULT_ARM_MS;
  }

  /**
   * Mark one navigation as waiting for its background answer.
   *
   * Idempotent per session: two shell documents in flight (a reload racing a
   * deep link) must not arm two answers.
   * @param {string} sid - session id the navigation was served under.
   * @returns {void}
   */
  arm(sid) {
    if (this.#pending.has(sid)) return;
    let resolve;
    const promise = new Promise((settle) => { resolve = settle; });
    const timer = setTimeout(() => { this.#settle(sid, 'timeout'); }, this.armMs);
    this.#pending.set(sid, { promise, resolve, timer });
  }

  /**
   * Whether this session is still waiting for an answer.
   * @param {string} sid
   * @returns {boolean}
   */
  armed(sid) {
    return this.#pending.has(sid);
  }

  /**
   * Report the answer for a navigation.
   * @param {string} sid
   * @param {'same' | 'switched' | 'skipped'} outcome
   * @returns {void}
   */
  settle(sid, outcome) {
    this.#settle(sid, outcome);
  }

  /**
   * Wait for the answer, bounded by `waitMs`.
   *
   * `idle` means nothing was armed, so there is nothing to wait for. `timeout`
   * means the answer did not arrive in time and the caller proceeds on the
   * session it already has.
   * @param {string} sid
   * @returns {Promise<'same' | 'switched' | 'skipped' | 'timeout' | 'idle'>}
   */
  async wait(sid) {
    const pending = this.#pending.get(sid);
    if (pending === undefined) return 'idle';
    let timer;
    const expiry = new Promise((settle) => {
      timer = setTimeout(() => { settle('timeout'); }, this.waitMs);
    });
    const outcome = await Promise.race([pending.promise, expiry]);
    clearTimeout(timer);
    // A navigation that waited once and learned nothing must not make every
    // later request pay the same wait: the window is spent, and the requests
    // behind it go through on the session they already have.
    if (outcome === 'timeout') this.#settle(sid, 'timeout');
    return outcome;
  }

  /**
   * @param {string} sid
   * @param {string} outcome
   * @returns {void}
   */
  #settle(sid, outcome) {
    const pending = this.#pending.get(sid);
    if (pending === undefined) return;
    this.#pending.delete(sid);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  }
}

/**
 * Whether a settled outcome may still serve tenant data.
 * @param {string} outcome - one `GATE_OUTCOMES` member.
 * @returns {boolean} false only when the account behind the session changed.
 */
export function mayServe(outcome) {
  return outcome !== 'switched';
}
