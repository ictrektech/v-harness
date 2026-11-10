/**
 * The document the gateway rewrites: the tenant's dsh shell.
 *
 * Three things ride on it, and all of them have to happen inside the shell
 * because the gateway owns no code in the browser:
 *
 *   1. The language entry the client locale plugin reads before it mounts.
 *   2. A URL bridge. The ingress only routes `/app/com.ictrek.v-harness`,
 *      `/api`, `/plugins`, `/assets`, `/__vh` and `/favicon.ico` of this origin
 *      to the gateway (ictrek.app/src/docker-compose.yml), so a plugin that
 *      serves its own routes — `@goodandready/dsh-gitea` fetches
 *      `/dsh-gitea/config` — is answered by the platform with 404. The bridge
 *      prefixes root-absolute same-origin requests with the application path,
 *      which is the one thing the plugin cannot know about itself.
 *   3. The restart affordance. A plugin bundle patch that carries configuration
 *      is applied by the bundle layer at startup only; the surface reports
 *      "restart to apply" but has no control that performs one.
 *
 * The scripts are classic, added before any module in the head, and never
 * throw: a broken bridge must not cost the user their workspace.
 *
 * @module v-harness/gateway/shell-inject
 */

/** Restart endpoint the injected button calls; the gateway answers it. */
export const RESTART_PATH = '/__vh/restart';

/**
 * The background identity check. It is loaded by every proxied document, and it
 * asks the gateway whether this navigation still owes an answer before it does
 * anything, so a load costs one cheap request in the common case.
 */
export const VERIFY_SCRIPT_SRC = '/__vh/verify.js';

/** Boot identity of the instance serving this document; polled by the script. */
export const BOOT_PATH = '/__vh/boot';

/** Encodings the shell can be decoded from before it is rewritten. */
export const DECODABLE_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

/** Copy for the restart affordance, keyed by the tenant's language. */
const COPY = {
  zh: {
    label: '重启工作区',
    hint: '安装插件后需重启才能生效',
    busy: '正在重启…',
  },
  en: {
    label: 'Restart workspace',
    hint: 'A plugin install takes effect after a restart',
    busy: 'Restarting…',
  },
};

/**
 * Rewrite one dsh shell document.
 * @param {string} html - the document as dsh served it.
 * @param {{ locale?: string, basePath?: string }} options - tenant language and
 *   the application path the ingress mounts this gateway under.
 * @returns {string} the document with the host scripts in its head.
 */
export function injectShell(html, { locale, basePath = '', shell = true }) {
  const copy = COPY[locale === 'en' ? 'en' : 'zh'];
  // A plugin's own document (a panel served at `/mcp-connector/ui/`) gets the
  // URL bridge and nothing else. The identity check, the language entry, the
  // restart button and the boot watcher belong to the workspace shell: planting
  // them in someone else's page made that page reload itself, and a 240 KB panel
  // reloading two seconds after it opened is exactly what the user sees as
  // "refreshing every few seconds".
  const scripts = shell
    ? `${verifyScript()}${localeScript(locale)}${runtimeScript(copy, basePath, true)}`
    : runtimeScript(copy, basePath, false);
  const head = /<head[^>]*>/iu.exec(html);
  // A document without a head still gets the scripts: prepending keeps the rest
  // of the markup untouched, and the browser hoists them either way.
  if (head === null) return `${scripts}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${scripts}${html.slice(at)}`;
}

/**
 * Load the background identity check.
 *
 * `defer` matters: the check must not delay the first paint, and it is the
 * thing that releases the gateway's data gate. A navigation that has nothing to
 * prove returns from it immediately.
 * @returns {string} the script tag.
 */
function verifyScript() {
  return `<script defer src="${VERIFY_SCRIPT_SRC}"></script>`;
}

/**
 * Publish the tenant's language to the surface.
 *
 * The browser locale plugin reads the `preferences-locale` entry before it
 * mounts, so writing it here opens the surface in the VOS language even when
 * the platform injects no locale bridge into the page; a language the user
 * chose in Settings is an explicit preference and still outranks it. The entry
 * is rewritten on every load, so a VOS language change reaches the next visit
 * instead of pinning the first one.
 * @param {string | undefined} locale - stored tenant language (`zh` / `en`).
 * @returns {string} the script tag, or an empty string for an unknown language.
 */
function localeScript(locale) {
  const tag = locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : '';
  if (tag === '') return '';
  return `<script>try{localStorage.setItem("preferences-locale",JSON.stringify({value:"${tag}"}))}catch(e){}</script>`;
}

/**
 * @param {{ label: string, hint: string, confirm: string, busy: string, failed: string }} copy
 * @param {string} basePath
 * @returns {string} the bridge script tag.
 */
function runtimeScript(copy, basePath, shell) {
  const config = JSON.stringify({ base: basePath, path: RESTART_PATH, boot: BOOT_PATH, copy, shell });
  return `<script>(function(){try{var vh=${config};${BRIDGE}}catch(e){}})();</script>`;
}

/**
 * The bridge body.
 *
 * `appPath` is the whole trick: a pathname that already lives under the
 * application path is left alone, everything else rooted at `/` is moved under
 * it. Requests that leave the origin are untouched, so a plugin still reaches
 * its own Gitea server.
 *
 * Written as one string rather than a function because it travels to the
 * browser verbatim; no `</script>` and no template interpolation may appear.
 */
const BRIDGE = `
var hasBase = typeof vh.base === "string" && vh.base.length > 0;
// The root paths the ingress already routes to this gateway: they need no
// help, and prefixing them would move them out of the control router.
var ROOT_ROUTES = ["/__vh", "/api", "/plugins", "/assets", "/favicon.ico", "/app"];
function routesAtRoot(path) {
  for (var i = 0; i < ROOT_ROUTES.length; i += 1) {
    if (path === ROOT_ROUTES[i] || path.indexOf(ROOT_ROUTES[i] + "/") === 0 || path.indexOf(ROOT_ROUTES[i] + "?") === 0) return true;
  }
  return false;
}
function appPath(path) {
  if (!hasBase) return path;
  if (path === vh.base || path.indexOf(vh.base + "/") === 0 || path.indexOf(vh.base + "?") === 0) return path;
  if (routesAtRoot(path)) return path;
  return vh.base + path;
}
function fixUrl(value) {
  var text = String(value);
  if (text === "") return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.slice(0, 2) === "//") {
    var abs;
    try { abs = new URL(text, location.href); } catch (e) { return value; }
    if (abs.origin !== location.origin) return value;
    var moved = appPath(abs.pathname) + abs.search + abs.hash;
    if (moved === abs.pathname + abs.search + abs.hash) return value;
    return abs.protocol + "//" + abs.host + moved;
  }
  if (text.charAt(0) !== "/") return value;
  return appPath(text);
}
var nativeFetch = window.fetch;
if (typeof nativeFetch === "function") {
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string") input = fixUrl(input);
      else if (typeof URL !== "undefined" && input instanceof URL) input = new URL(fixUrl(input.href));
      else if (typeof Request === "function" && input instanceof Request) {
        var moved = fixUrl(input.url);
        if (moved !== input.url) input = new Request(moved, input);
      }
    } catch (e) {}
    return nativeFetch.call(this, input, init);
  };
}
var nativeOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url) {
  var args = Array.prototype.slice.call(arguments);
  try { args[1] = fixUrl(url); } catch (e) {}
  return nativeOpen.apply(this, args);
};
var nativeBeacon = navigator.sendBeacon;
if (typeof nativeBeacon === "function") {
  navigator.sendBeacon = function (url, data) {
    var moved = url;
    try { moved = fixUrl(url); } catch (e) {}
    return nativeBeacon.call(navigator, moved, data);
  };
}
function wrapSocket(native) {
  if (typeof native !== "function") return native;
  var Wrapped = function (url, options) {
    var moved = url;
    try { moved = fixUrl(url); } catch (e) {}
    return options === undefined ? new native(moved) : new native(moved, options);
  };
  Wrapped.prototype = native.prototype;
  Wrapped.CONNECTING = native.CONNECTING;
  Wrapped.OPEN = native.OPEN;
  Wrapped.CLOSING = native.CLOSING;
  Wrapped.CLOSED = native.CLOSED;
  return Wrapped;
}
if (typeof window.WebSocket === "function") window.WebSocket = wrapSocket(window.WebSocket);
if (typeof window.EventSource === "function") window.EventSource = wrapSocket(window.EventSource);

// Everything below belongs to the workspace shell. A plugin's document only
// needs the URL rewriting above; the restart affordance and the boot watcher
// would act on a page this gateway never launched.
if (vh.shell === true) {
function requestRestart() {
  return fetch(vh.path, { method: "POST", credentials: "same-origin", cache: "no-store", body: "" });
}
// The gateway answers before it drains and keeps launching until the
// replacement is up, so the page reloads either way: it lands on the starting
// page, which is also where the owner waits for any other restart to finish.
function reloadForRestart() {
  setTimeout(function () { location.reload(); }, 400);
}
// The market's restart button calls this hook when it exists; without it the
// market spawns its own replacement process, which this gateway does not track
// — the old cookie dies with it and the port is fought over on the next launch.
try {
  var shell = window.__dshHostShell;
  if (shell === undefined || shell === null) shell = window.__dshHostShell = {};
  if (typeof shell.restart !== "function") {
    shell.restart = function () {
      requestRestart().then(reloadForRestart, reloadForRestart);
    };
  }
} catch (e) {}
function restart(button) {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = vh.copy.busy;
  requestRestart().then(reloadForRestart, reloadForRestart);
}
function mountRestart() {
  if (document.getElementById("vh-restart")) return;
  var button = document.createElement("button");
  button.id = "vh-restart";
  button.type = "button";
  button.textContent = vh.copy.label;
  button.title = vh.copy.hint;
  button.style.cssText = [
    "position:fixed", "right:18px", "bottom:18px", "z-index:2147483000",
    "padding:7px 14px", "border:1px solid rgba(255,255,255,.14)", "border-radius:999px",
    "background:rgba(30,34,42,.88)", "color:#e8eaef", "font:500 13px/1.6 system-ui,sans-serif",
    "letter-spacing:.02em", "cursor:pointer", "box-shadow:0 6px 20px rgba(0,0,0,.28)",
    "opacity:.8", "transition:opacity .15s ease",
  ].join(";");
  button.addEventListener("mouseenter", function () { button.style.opacity = "1"; });
  button.addEventListener("mouseleave", function () { button.style.opacity = ".8"; });
  button.addEventListener("click", function () { restart(button); });
  (document.body || document.documentElement).appendChild(button);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountRestart);
else mountRestart();
// A restart replaces the process this document came from: the bundle URLs it
// holds carry a revision the new process never served, and every plugin the
// document has not mounted yet would 404. The gateway publishes the current
// boot, so a change means this document is stale — reload, which is also what
// the market's own "restarting" surface never does on its own.
var vhBoot = null;
function watchBoot() {
  if (typeof fetch !== "function") return;
  fetch(vh.boot, { credentials: "same-origin", cache: "no-store" })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      if (!data || typeof data.boot !== "number" || data.boot === 0) return;
      if (vhBoot === null) { vhBoot = data.boot; return; }
      if (data.boot !== vhBoot) { vhBoot = data.boot; location.reload(); }
    })
    .catch(function () {});
}
try {
  setTimeout(watchBoot, 1500);
  setInterval(watchBoot, 2000);
} catch (e) {}
}
`;
