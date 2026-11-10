/** Serve the offline VOS API reference without exposing tenant state. */
import { readFile } from 'node:fs/promises';

/**
 * Answer the documentation route; other routes remain with the caller.
 * @param {import('node:http').IncomingMessage} req - HTTP request.
 * @param {import('node:http').ServerResponse} res - HTTP response.
 * @param {string} pathname - Gateway-relative request pathname.
 * @returns {Promise<boolean>} Whether this documentation route was handled.
 */
export async function serveApiGuide(req, res, pathname) {
  if (pathname !== '/__vh/api-guide') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  const page = await readFile(new URL('./api-guide.html', import.meta.url));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
    'content-length': page.length, 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : page);
  return true;
}
