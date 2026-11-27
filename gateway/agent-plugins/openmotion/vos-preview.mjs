/** Publish tenant-local preview links through the existing VOS services panel. */
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ports = new Set();
const directory = '/usr/local/share/vh-openmotion';
function announce(port) {
  const body = JSON.stringify({
    name: 'OpenMotion', port, cwd: join(homedir(), 'workspace'),
    cmd: ['node', '--experimental-strip-types', directory + '/vos-server.mjs', String(port)],
  });
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: join(homedir(), '.dsh', 'vh-services.sock'),
      path: ports.has(port) ? '/services/' + port + '/ping' : '/services',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      res.resume();
      res.once('end', () => {
        if (res.statusCode !== 200) reject(new Error('OpenMotion preview registration HTTP ' + res.statusCode));
        else { ports.add(port); resolve(); }
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('OpenMotion preview registration timed out')));
    req.once('error', reject);
    req.end(body);
  });
}
const heartbeat = setInterval(() => {
  for (const port of ports) void announce(port).catch(error => console.error(error.message));
}, 10000);
heartbeat.unref();

export async function exposePreview(response) {
  const encoded = JSON.stringify(response);
  const local = new Set(['localhost', '127.0.0.1', process.env.VH_TENANT_IP]);
  const matches = [...encoded.matchAll(/http:\/\/([a-z0-9.]+):(\d+)(?=[/\\"])/g)]
    .filter(match => local.has(match[1]));
  let result = encoded;
  for (const match of matches) {
    const port = Number(match[2]);
    if (port < 1024 || port > 65535 || (port >= 3100 && port <= 3999)) continue;
    try {
      await announce(port);
      result = result.replaceAll(match[0], '/__vh/svc/' + port);
    } catch (error) {
      console.error(error.message);
    }
  }
  result = result.replaceAll(
    'Use the host built-in browser to open previewUrl in this conversation.',
    'Return the complete mapped VOS previewUrl to the user, who opens it in their authenticated browser. Do not open it in a server-side browser or start another server.',
  );
  const adapted = JSON.parse(result);
  if (adapted.result?.serverInfo?.name === 'openmotion' && typeof adapted.result.instructions === 'string') {
    adapted.result.instructions += '\nVOS integration: preview and Studio run in the user\'s authenticated VOS browser. Return the mapped preview link and explain that the user can click it or open Services. A server-side browser does not carry that login. Do not install another OpenMotion copy, launch another server, or claim the user has already opened the page.';
  }
  return adapted;
}
