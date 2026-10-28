/**
 * VOS OIDC Fastpath identity verification.
 *
 * The VOS platform injects `window.vos_platform.api.v1000.oauth2` into the app
 * iframe; the client silently completes a PKCE authorization-code exchange and
 * posts the resulting access token here. This module turns that token into a
 * stable platform identity. It never stores the token.
 *
 * @module v-harness/gateway/vos-auth
 */

import { createHash } from 'node:crypto';

const DEFAULT_USERINFO_URL = 'http://172.17.0.1:8105/v1000/oauth2/userinfo';
const USERINFO_TIMEOUT_MS = 8_000;

/** Identity derived from one verified VOS token. */
export class VosAuthError extends Error {
  /**
   * @param {string} code - stable failure code for the HTTP layer.
   * @param {string} message - operator-facing detail; never rendered to users.
   */
  constructor(code, message) {
    super(message);
    this.name = 'VosAuthError';
    this.code = code;
  }
}

/**
 * Read one claim from a claims object, accepting string or finite number.
 * @param {Record<string, unknown>} claims
 * @param {...string} names - candidates in preference order.
 * @returns {string} trimmed text, or '' when absent.
 */
export function claim(claims, ...names) {
  for (const name of names) {
    const value = claims[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/**
 * Narrow one BCP 47 tag to the languages the product ships.
 *
 * Traditional Chinese resolves to Simplified: the client ships no `zh-TW`
 * texts, and a reader of either script reads the other better than English.
 * @param {unknown} value - untrusted tag from a claim, a header, or storage.
 * @returns {'zh' | 'en' | ''} the shipped language id, or '' when unsupported.
 */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return '';
  const tag = value.trim().replace(/_/g, '-').toLowerCase();
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh';
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  return '';
}

/**
 * Pick the first shipped language out of an ordered list of tags.
 * @param {readonly string[]} tags - preference order, e.g. Accept-Language parts.
 * @returns {'zh' | 'en' | ''}
 */
function firstLanguage(tags) {
  for (const tag of tags) {
    const language = normalizeLanguage(tag);
    if (language !== '') return language;
  }
  return '';
}

/**
 * Normalize a VOS userinfo body into identity fields.
 *
 * VOS answers an invalid token with HTTP 200 and a ResultBody error envelope
 * (`{code: 10001, ...}`), so the status code alone is not a verdict. Success
 * is either flat OIDC claims or the same claims under `data`.
 *
 * `locale` is the VOS interface language the person is reading the platform
 * in; it decides both the surface copy and the language the agent answers in.
 * A deployment whose userinfo carries no locale claim falls back to the
 * ordered tags the caller passed (the browser's Accept-Language).
 *
 * @param {unknown} payload - parsed JSON body.
 * @param {readonly string[]} [languages] - fallback tags in preference order.
 * @returns {{ subject: string, username: string, admin: boolean, namespace: string, locale: string }}
 */
export function identityFromPayload(payload, languages = []) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new VosAuthError('vos-invalid-userinfo', 'VOS userinfo response is not an object');
  }
  const outer = /** @type {Record<string, unknown>} */ (payload);
  if (typeof outer.code === 'number' && outer.code !== 0) {
    throw new VosAuthError(
      'vos-token-rejected',
      `VOS rejected the access token (code ${String(outer.code)})`,
    );
  }
  const nested = outer.data;
  const claims = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? /** @type {Record<string, unknown>} */ (nested)
    : outer;

  const subject = claim(claims, 'sub', 'id', 'user_id');
  if (!subject) {
    throw new VosAuthError('vos-no-subject', 'VOS userinfo carries no immutable subject');
  }
  const username = claim(claims, 'preferred_username', 'username', 'name', 'nickname', 'email')
    || subject;
  const rawRoles = claims.roles;
  const roles = Array.isArray(rawRoles)
    ? rawRoles.map(String)
    : [claim(claims, 'role')].filter(Boolean);
  const admin = claims.is_admin === true
    || roles.some((role) => role.toLowerCase() === 'admin');

  return Object.freeze({
    subject,
    username,
    admin,
    // Directory and uid derive from the immutable subject, never the display
    // name: two VOS accounts can resolve to the same username.
    namespace: createHash('sha256').update(`vos-oidc\0${subject}`).digest('hex').slice(0, 40),
    locale: normalizeLanguage(claim(claims, 'locale', 'language', 'lang')) || firstLanguage(languages),
  });
}

/**
 * Resolve the userinfo endpoint for this deployment.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function userinfoUrl(env = process.env) {
  return env.VOS_OIDC_USERINFO_URL?.trim() || DEFAULT_USERINFO_URL;
}

/**
 * Verify one VOS access token and return its identity.
 * @param {string} accessToken - Fastpath access token from the client.
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   env?: NodeJS.ProcessEnv,
 *   acceptLanguage?: string,
 * }} [options] - `acceptLanguage` is the fallback when userinfo names no locale.
 * @returns {Promise<{ subject: string, username: string, admin: boolean, namespace: string, locale: string }>}
 * @throws {VosAuthError} when the token is missing, rejected, or the endpoint fails.
 */
export async function verifyVosToken(accessToken, options = {}) {
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!token) throw new VosAuthError('vos-missing-token', 'access_token is required');

  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try {
    response = await fetchImpl(userinfoUrl(options.env), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
  } catch (error) {
    throw new VosAuthError(
      'vos-userinfo-unreachable',
      `VOS userinfo request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new VosAuthError('vos-userinfo-status', `VOS userinfo returned HTTP ${String(response.status)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new VosAuthError('vos-invalid-userinfo', 'VOS userinfo did not return JSON');
  }
  const accept = typeof options.acceptLanguage === 'string' ? options.acceptLanguage.split(',') : [];
  // The preference weight (`;q=0.9`) is ordering noise here: the header is
  // already ordered, and a q-value must not turn a tag into an unknown one.
  return identityFromPayload(payload, accept.map((entry) => entry.split(';')[0]?.trim() ?? ''));
}
