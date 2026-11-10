/**
 * Guard against a call whose import was dropped by a refactor.
 *
 * A gateway module that calls `connect()` without `import { connect } from
 * 'node:net'` still passes `node --check`, still loads, and only fails when the
 * code path finally runs — which for `proxyUpgrade` means every WebSocket
 * upgrade in the deployment breaks while every other route stays healthy.
 * Unit tests never reach that path, so the invariant is asserted statically.
 *
 * @module v-harness/gateway/import-wiring.test
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const GATEWAY_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Built-in entry points the gateway calls by bare name. The list holds only
 * names that are not idiomatically used as callback parameters, so a match on
 * `name(` cannot be explained away by a local binding the scan does not model.
 */
const BUILTIN_CALLS = [
  'connect',
  'createServer',
  'createConnection',
  'httpRequest',
  'join',
  'dirname',
  'basename',
  'readFile',
  'writeFile',
  'readdir',
  'mkdir',
  'rm',
  'stat',
  'access',
  'spawn',
  'execFile',
  'execFileSync',
  'spawnSync',
  'randomUUID',
  'randomBytes',
  'createHash',
  'createHmac',
  'gunzipSync',
  'brotliDecompressSync',
  'inflateSync',
  'inflateRawSync',
  'fileURLToPath',
  'networkInterfaces',
  'isIP',
];

/**
 * @param {string} source - module text.
 * @returns {Set<string>} the names bound by `import … from 'node:…'`.
 */
function nodeImports(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:[^'"]+['"]/g)) {
    for (const part of match[1].split(',')) {
      const bound = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (bound) names.add(bound);
    }
  }
  for (const match of source.matchAll(/import\s+(\w+)\s*from\s*['"]node:[^'"]+['"]/g)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Drop prose that mentions a call without making one.
 * @param {string} source - module text.
 * @returns {string} the module with block and line comments removed.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/[^\n]*/g, '');
}

/**
 * @param {string} source - module text.
 * @param {string} name - candidate binding.
 * @returns {boolean} whether the module declares the name itself.
 */
function declaresLocally(source, name) {
  return (
    new RegExp(`(?:function|class)\\s+${name}\\b`).test(source) ||
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=`).test(source)
  );
}

test('every built-in call has a matching node: import', async () => {
  const files = (await readdir(GATEWAY_DIR)).filter(
    (name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'),
  );
  assert.ok(files.length > 10, 'the scan has to see the gateway modules');

  const problems = [];
  for (const file of files.sort()) {
    const raw = await readFile(join(GATEWAY_DIR, file), 'utf8');
    const source = stripComments(raw);
    const imported = nodeImports(raw);
    for (const name of BUILTIN_CALLS) {
      if (!new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(source)) continue;
      if (imported.has(name) || declaresLocally(source, name)) continue;
      problems.push(`${file} calls ${name}() without importing it`);
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the upgrade path keeps its socket import', async () => {
  const source = await readFile(join(GATEWAY_DIR, 'server.mjs'), 'utf8');
  // `proxyUpgrade` is the one place a missing import survives every health
  // check: the failure surfaces as an upgrade error, not as a dead server.
  if (!/(?<![.\w$])connect\s*\(/.test(source)) return;
  assert.match(source, /import\s*\{[^}]*\bconnect\b[^}]*\}\s*from\s*['"]node:net['"]/);
});
