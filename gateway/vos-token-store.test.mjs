import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A VOS token endpoint stand-in: `revoked` is an invalid_grant, everything
// else rotates the whole set. It is installed before the store is imported,
// because the store reads its endpoint once at module load.
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += String(chunk); });
  req.on('end', () => {
    const params = new URLSearchParams(body);
    if (params.get('refresh_token') === 'revoked') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_grant"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      access_token: 'refreshed-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
    }));
  });
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
process.env.VOS_TOKEN_URL = `http://127.0.0.1:${String(upstream.address().port)}/token`;

const store = await import('./vos-token-store.mjs');

after(async () => {
  await new Promise((resolve) => { upstream.close(resolve); });
});

/**
 * @returns {Promise<{ root: string, path: string }>}
 */
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'vh-tokens-'));
  return { root, path: join(root, 'vos-tokens.json') };
}

test('credentials survive a gateway restart in a 0600 root-owned store', async () => {
  const { root, path } = await scratch();
  try {
    store.initTokenStore(path);
    const expiresAt = Date.now() + 3_600_000;
    store.rememberTokens('alice', { access: 'alice-access', refresh: 'alice-refresh', expiresAt });

    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.alice.access, 'alice-access');
    assert.equal(onDisk.alice.refresh, 'alice-refresh');
    assert.equal(onDisk.alice.expiresAt, expiresAt);

    // A fresh gateway clears its own map and reads the file back.
    store.initTokenStore(path);
    assert.equal(store.hasUsableTokens('alice'), true);
    assert.equal(await store.accessTokenFor('alice'), 'alice-access');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restore drops dead entries but keeps refreshable ones', async () => {
  const { root, path } = await scratch();
  try {
    store.initTokenStore(path);
    store.rememberTokens('fresh', { access: 'fresh-access', expiresAt: Date.now() + 3_600_000 });
    store.rememberTokens('renewable', { access: 'old-access', refresh: 'renew', expiresAt: Date.now() - 1_000 });
    store.rememberTokens('dead', { access: 'dead-access', expiresAt: Date.now() - 1_000 });

    store.initTokenStore(path);
    assert.equal(store.hasUsableTokens('fresh'), true);
    assert.equal(store.hasUsableTokens('renewable'), true);
    assert.equal(store.hasUsableTokens('dead'), false);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.dead, undefined, 'dead credentials are purged from disk too');
    assert.equal(onDisk.renewable.refresh, 'renew');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing, damaged or too-readable store starts empty', async () => {
  const { root, path } = await scratch();
  try {
    store.initTokenStore(path);
    assert.equal(store.hasUsableTokens('alice'), false);

    store.rememberTokens('alice', { access: 'alice-access', expiresAt: Date.now() + 3_600_000 });
    await writeFile(path, '{damaged', 'utf8');
    store.initTokenStore(path);
    assert.equal(store.hasUsableTokens('alice'), false);

    store.rememberTokens('alice', { access: 'alice-access', expiresAt: Date.now() + 3_600_000 });
    await chmod(path, 0o644);
    store.initTokenStore(path);
    assert.equal(store.hasUsableTokens('alice'), false, 'a world-readable file is never trusted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('forgetTokens removes the credential from memory and disk', async () => {
  const { root, path } = await scratch();
  try {
    store.initTokenStore(path);
    store.rememberTokens('alice', { access: 'alice-access', expiresAt: Date.now() + 3_600_000 });
    store.rememberTokens('bob', { access: 'bob-access', expiresAt: Date.now() + 3_600_000 });
    store.forgetTokens('alice');
    assert.equal(store.hasUsableTokens('alice'), false);
    assert.equal(store.hasUsableTokens('bob'), true);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.alice, undefined);
    assert.equal(onDisk.bob.access, 'bob-access');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a successful refresh is persisted without a browser replay', async () => {
  const { root, path } = await scratch();
  try {
    store.initTokenStore(path);
    store.rememberTokens('renewable', { access: 'old-access', refresh: 'good', expiresAt: Date.now() - 1_000 });
    assert.equal(await store.accessTokenFor('renewable'), 'refreshed-access');

    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.renewable.access, 'refreshed-access');
    assert.equal(onDisk.renewable.refresh, 'rotated-refresh');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a refused refresh drops the credential everywhere', async () => {
  const { root, path } = await scratch();
  try {
    store.initTokenStore(path);
    store.rememberTokens('revoked', { access: 'old-access', refresh: 'revoked', expiresAt: Date.now() - 1_000 });
    assert.equal(await store.accessTokenFor('revoked'), undefined);
    assert.equal(store.hasUsableTokens('revoked'), false);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).revoked, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expiryFromToken prefers expires_in and falls back to the JWT claim', () => {
  const claims = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString('base64url');
  const jwt = `header.${claims}.signature`;
  assert.equal(store.expiryFromToken(jwt), 1_900_000_000_000);
  const ttl = Date.now();
  const fromTtl = store.expiryFromToken(jwt, 120);
  assert.ok(fromTtl >= ttl + 120_000 && fromTtl <= Date.now() + 120_000);
  assert.ok(store.expiryFromToken('opaque') > Date.now());
});
