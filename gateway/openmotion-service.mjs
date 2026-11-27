/** Translate a verified same-origin browser request into OpenMotion's local-only HTTP contract. */
export function openMotionHeaders(req, headers) {
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { return false; }
    if (origin.host !== req.headers.host || !['http:','https:'].includes(origin.protocol)) return false;
    headers.origin = 'http://' + headers.host;
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.referer) headers.referer = 'http://' + headers.host + '/';
  return true;
}
