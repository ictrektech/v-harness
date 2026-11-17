/**
 * The ticket a browser tab presents for itself.
 *
 * A browser has exactly one `vh_session` cookie per origin, so two accounts
 * signed in in two tabs share it: whichever tab proves itself last rewrites it
 * for both, and the other tab's requests are answered as the new account. This
 * module is the gateway half of the cure — the tab names the session it was
 * served under, and that explicit ticket outranks the cookie.
 *
 * The ticket travels as the `x-vh-session` header on fetches (injected by
 * `shell-inject`), or as the `__vh_tab` query parameter on the requests a
 * browser cannot put a header on: the WebSocket handshake and `EventSource`.
 *
 * Neither channel ever reaches the tenant's dsh: both are stripped from the
 * upstream request, so a plugin cannot replay the browser's credential.
 *
 * @module v-harness/gateway/tab-ticket
 */

/**
 * Header carrying the ticket. It predates tabs: the bootstrap page already
 * hands its session back this way when a browser refuses the cookie, so the
 * channel and its name exist for the same reason.
 */
export const TICKET_HEADER = 'x-vh-session';

/** Query parameter carrying the ticket where a header cannot go. */
export const TICKET_PARAM = '__vh_tab';

/**
 * @param {string} url - a request target, absolute or path-only.
 * @returns {string | undefined}
 */
function queryTicket(url) {
  if (typeof url !== 'string' || !url.includes(TICKET_PARAM)) return undefined;
  try {
    const value = new URL(url, 'http://gateway.invalid').searchParams.get(TICKET_PARAM);
    return value === null || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * The ticket this request names explicitly, if any.
 *
 * The header wins: it is what the injected script stamps on every request of a
 * tab, and a page that states its own ticket is asking for exactly that tenant.
 * @param {{ headers: Record<string, string | string[] | undefined>, url?: string }} req
 * @returns {string | undefined} the ticket, or undefined when the request names none.
 */
export function explicitTicket(req) {
  const raw = req.headers[TICKET_HEADER];
  if (typeof raw === 'string' && raw !== '') return raw;
  return queryTicket(req.url);
}

/**
 * Drop the ticket parameter before the request reaches a tenant.
 *
 * Returns path and query without an origin: every caller proxies a request
 * target rather than a full URL.
 * @param {string} url
 * @returns {string}
 */
export function stripTicketParam(url) {
  if (typeof url !== 'string' || !url.includes(TICKET_PARAM)) return url;
  try {
    const parsed = new URL(url, 'http://gateway.invalid');
    if (!parsed.searchParams.has(TICKET_PARAM)) return url;
    parsed.searchParams.delete(TICKET_PARAM);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}
