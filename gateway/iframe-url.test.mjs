/**
 * A plugin opens its panel at `location.origin + "/<plugin>/ui/"` — a document
 * request, so it never reaches the fetch/XHR bridge. The frame address has to
 * move under the application prefix itself, or the panel asks the ingress for a
 * root path this deployment cannot own.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { injectShell } from './shell-inject.mjs';

const BASE = '/app/com.ictrek.v-harness';

/**
 * Run the injected bridge against a minimal DOM.
 * @returns {Record<string, any>} the sandbox it ran in.
 */
function runBridge() {
  const html = injectShell('<html><head></head><body></body></html>', {
    locale: 'zh',
    basePath: BASE,
    shell: true,
  });
  // Several scripts are injected; the bridge is the one carrying the URL rewrite.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((m) => m[1]);
  const bridge = scripts.find((code) => code.includes('fixUrl'));
  assert.ok(bridge !== undefined);

  /** @type {Record<string, any>} */
  const sandbox = {
    XMLHttpRequest: class { open() {} },
    navigator: {},
    location: new URL(`https://vos.example${BASE}/`),
    document: {
      readyState: 'complete',
      getElementById: () => null,
      createElement: () => ({ style: {}, addEventListener() {}, appendChild() {} }),
      documentElement: { appendChild() {} },
      body: null,
    },
    URL,
    Request,
    console,
    setTimeout: () => 0,
    setInterval: () => 0,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  };
  sandbox.window = sandbox;
  sandbox.Element = class {
    constructor(tagName) { this.tagName = tagName; }
    setAttribute(name, value) { this[name] = value; }
  };
  sandbox.HTMLIFrameElement = class extends sandbox.Element {
    constructor() {
      super('IFRAME');
      this.storedSrc = '';
    }
    get src() { return this.storedSrc; }
    set src(value) { this.storedSrc = value; }
  };
  vm.runInNewContext(bridge, sandbox);
  return sandbox;
}

test('a panel opened at the origin root moves under the app prefix', () => {
  const sandbox = runBridge();
  const frame = new sandbox.HTMLIFrameElement();
  frame.src = 'https://vos.example/mcp-connector/ui/';
  assert.equal(frame.src, `https://vos.example${BASE}/mcp-connector/ui/`);
});

test('the same move happens through setAttribute', () => {
  const sandbox = runBridge();
  const frame = new sandbox.HTMLIFrameElement();
  frame.setAttribute('src', '/mcp-connector/ui/');
  assert.equal(frame.src, `${BASE}/mcp-connector/ui/`);
});

test('addresses that must stay put are left alone', () => {
  const sandbox = runBridge();
  const frame = new sandbox.HTMLIFrameElement();
  frame.src = `https://vos.example${BASE}/`;
  assert.equal(frame.src, `https://vos.example${BASE}/`);
  frame.src = 'https://other.example/mcp-connector/ui/';
  assert.equal(frame.src, 'https://other.example/mcp-connector/ui/');
});

test('setAttribute on any other element is untouched', () => {
  const sandbox = runBridge();
  const element = new sandbox.Element('DIV');
  element.setAttribute('src', '/mcp-connector/ui/');
  assert.equal(element.src, '/mcp-connector/ui/');
});
