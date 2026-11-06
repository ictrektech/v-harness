/**
 * The shell rewrite: the tenant's language, the application-path bridge that
 * keeps plugin-served routes out of the platform's 404, and the restart button.
 *
 * Run: `node --test gateway/shell-inject.test.mjs`
 * @module v-harness/gateway/shell-inject.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { RESTART_PATH, injectShell } from './shell-inject.mjs';

const SHELL = '<html><head><meta charset="utf-8"><script type="module" src="./assets/entry.js"></script></head><body></body></html>';

/** @param {string} html @returns {string[]} the inline scripts, in order. */
function scriptsOf(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]);
}

test('the host scripts land in the head, before the entry module', () => {
  const html = injectShell(SHELL, { locale: 'zh', basePath: '/app/com.ictrek.v-harness' });
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  const entry = head.indexOf('assets/entry.js');
  assert.ok(entry > 0);
  for (const script of scriptsOf(head)) assert.ok(html.indexOf(script) < entry);
});

test('the rewrite inserts and never edits', () => {
  const html = injectShell(SHELL, { locale: 'en', basePath: '' });
  // Removing what was injected gives back exactly the document dsh served.
  assert.equal(html.replace(/<script>[\s\S]*?<\/script>/gu, ''), SHELL);
});

test('the language entry carries the tenant language and nothing else', () => {
  assert.ok(injectShell(SHELL, { locale: 'zh' }).includes('"zh-CN"'));
  assert.ok(injectShell(SHELL, { locale: 'en' }).includes('"en-US"'));
  assert.ok(!injectShell(SHELL, { locale: undefined }).includes('preferences-locale'));
});

test('the bridge is told where the gateway is mounted', () => {
  const html = injectShell(SHELL, { locale: 'zh', basePath: '/app/com.ictrek.v-harness' });
  assert.ok(html.includes('"base":"/app/com.ictrek.v-harness"'));
  assert.ok(html.includes(`"path":"${RESTART_PATH}"`));
  // The copy is the tenant's: the button reads in the surface language.
  assert.ok(html.includes('重启工作区'));
  assert.ok(injectShell(SHELL, { locale: 'en', basePath: '' }).includes('Restart workspace'));
});

test('a document without a head still gets the scripts', () => {
  const html = injectShell('<body>hi</body>', { locale: 'zh', basePath: '/app/x' });
  assert.ok(html.endsWith('<body>hi</body>'));
  assert.equal(scriptsOf(html).length, 2);
});

test('the injected script survives a document that is not a full page', () => {
  const html = injectShell('', { locale: 'zh', basePath: '' });
  assert.equal(scriptsOf(html).length, 2);
  assert.ok(!html.includes('</script><script></script>'));
});

/**
 * Run the bridge in a sandbox that records what the page would request.
 * @param {string} basePath
 * @param {string} origin
 * @returns {{ fetch: string[], xhr: string[], context: Record<string, any> }}
 */
function loadBridge(basePath, origin = 'https://vos.example') {
  const html = injectShell('<html><head></head><body></body></html>', { locale: 'zh', basePath });
  const bridge = scriptsOf(html)[1];
  assert.ok(bridge !== undefined && bridge.includes('ROOT_ROUTES'));
  const asked = { fetch: /** @type {string[]} */ ([]), xhr: /** @type {string[]} */ ([]) };
  class FakeXhr {
    /** @param {string} method @param {string} url */
    open(method, url) {
      assert.equal(method, 'GET');
      asked.xhr.push(url);
    }
  }
  /** @type {Record<string, any>} */
  const sandbox = {
    XMLHttpRequest: FakeXhr,
    navigator: {},
    location: new URL(`${origin}${basePath}/`),
    document: {
      readyState: 'complete',
      getElementById: () => null,
      createElement: () => ({ style: {}, addEventListener() {}, appendChild() {} }),
      documentElement: { appendChild() {} },
    },
    URL,
    Request,
    console,
  };
  sandbox.fetch = (/** @type {string} */ url) => {
    asked.fetch.push(typeof url === 'string' ? url : String(url));
    return Promise.resolve();
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bridge, sandbox);
  return { ...asked, context: sandbox };
}

test('a plugin route moves under the application path', () => {
  const bridge = loadBridge('/app/com.ictrek.v-harness');
  bridge.context.fetch('/dsh-gitea/config');
  bridge.context.XMLHttpRequest.prototype.open.call({}, 'GET', '/dsh-gitea/status');
  assert.deepEqual(bridge.fetch, ['/app/com.ictrek.v-harness/dsh-gitea/config']);
  assert.deepEqual(bridge.xhr, ['/app/com.ictrek.v-harness/dsh-gitea/status']);
});

test('prefixing is idempotent and leaves the origin alone', () => {
  const bridge = loadBridge('/app/com.ictrek.v-harness');
  bridge.context.fetch('/app/com.ictrek.v-harness/dsh-gitea/config');
  bridge.context.fetch('/app/com.ictrek.v-harness');
  bridge.context.fetch('https://gitea.internal/api/v1/repos?limit=1');
  bridge.context.fetch('//gitea.internal/api/v1/repos');
  assert.deepEqual(bridge.fetch, [
    '/app/com.ictrek.v-harness/dsh-gitea/config',
    '/app/com.ictrek.v-harness',
    'https://gitea.internal/api/v1/repos?limit=1',
    '//gitea.internal/api/v1/repos',
  ]);
});

test('the paths the ingress already routes stay at the root', () => {
  const bridge = loadBridge('/app/com.ictrek.v-harness');
  for (const path of ['/__vh/restart', '/__vh/health', '/api/remote.mux', '/plugins/x.js', '/assets/a.css', '/favicon.ico']) {
    bridge.context.fetch(path);
  }
  assert.deepEqual(bridge.fetch, ['/__vh/restart', '/__vh/health', '/api/remote.mux', '/plugins/x.js', '/assets/a.css', '/favicon.ico']);
});

test('a same-origin absolute URL keeps its origin and moves its path', () => {
  const bridge = loadBridge('/app/com.ictrek.v-harness');
  bridge.context.fetch('https://vos.example/dsh-gitea/config?a=1');
  assert.deepEqual(bridge.fetch, ['https://vos.example/app/com.ictrek.v-harness/dsh-gitea/config?a=1']);
});

test('without an application path nothing is rewritten', () => {
  const bridge = loadBridge('');
  bridge.context.fetch('/dsh-gitea/config');
  bridge.context.XMLHttpRequest.prototype.open.call({}, 'GET', '/dsh-gitea/config');
  assert.deepEqual(bridge.fetch, ['/dsh-gitea/config']);
  assert.deepEqual(bridge.xhr, ['/dsh-gitea/config']);
});
