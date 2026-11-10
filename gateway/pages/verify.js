/**
 * The background identity check.
 *
 * The gateway serves the workspace without asking the platform who is browsing:
 * the shell is generic code, carries no tenant data, and blocking a navigation
 * on a six-leg asynchronous chain is what made every entry feel like a relaunch.
 * This script asks the question after the page is already on screen, and reports
 * the answer back. When the answer names a different account the page reloads;
 * when it names the same account nothing visible happens at all.
 *
 * It is a classic script injected into every HTML document the gateway proxies,
 * so it never uses module syntax and never throws: a broken check must cost the
 * user nothing. The gateway's data gate is what keeps the short window between
 * "page rendered" and "answer arrived" from serving one tenant's data under
 * another tenant's browser.
 *
 * Served from `/__vh/verify.js`; not part of the build.
 */
(function () {
  'use strict';

  if (window.__vhIdentityCheck === true) return;
  window.__vhIdentityCheck = true;

  var SESSION_PATH = '/__vh/session';
  var VERIFY_PATH = '/__vh/verify';
  var BRIDGE_WAIT_MS = 2500;
  var EXCHANGE_WAIT_MS = 8000;

  var b64 = function (bytes) {
    return btoa(String.fromCharCode.apply(null, bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  };
  var rand = function (n) {
    return b64(crypto.getRandomValues(new Uint8Array(n || 32)));
  };

  // crypto.subtle only exists in a secure context, and an internal VOS portal is
  // often plain HTTP. PKCE still needs SHA-256 there, so carry a small one.
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  var rotr = function (x, n) { return (x >>> n) | (x << (32 - n)); };

  function sha256(data) {
    var len = data.length;
    var bits = len * 8;
    var padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(data);
    padded[len] = 0x80;
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(padded.length - 4, bits >>> 0);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Uint32Array(64);
    for (var i = 0; i < padded.length; i += 64) {
      for (var t = 0; t < 16; t += 1) w[t] = dv.getUint32(i + t * 4);
      for (t = 16; t < 64; t += 1) {
        var a15 = w[t - 15];
        var a2 = w[t - 2];
        var s0 = rotr(a15, 7) ^ rotr(a15, 18) ^ (a15 >>> 3);
        var s1 = rotr(a2, 17) ^ rotr(a2, 19) ^ (a2 >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t += 1) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (h + S1 + ch + K256[t] + w[t]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    var odv = new DataView(out.buffer);
    for (i = 0; i < 8; i += 1) odv.setUint32(i * 4, H[i]);
    return out;
  }

  function sha256Bytes(data) {
    if (crypto.subtle) {
      return crypto.subtle.digest('SHA-256', data).then(function (digest) {
        return new Uint8Array(digest);
      });
    }
    return Promise.resolve(sha256(data));
  }

  function withTimeout(promise, ms, tag) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error(tag + ' timeout')); }, ms);
      }),
    ]);
  }

  function bridge(waitMs) {
    var direct = window.vos_platform && window.vos_platform.api && window.vos_platform.api.v1000
      && window.vos_platform.api.v1000.oauth2;
    if (direct) return Promise.resolve(direct);
    if (window.parent === window) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var waited = 0;
      var step = 200;
      var tick = setInterval(function () {
        var found = window.vos_platform && window.vos_platform.api && window.vos_platform.api.v1000
          && window.vos_platform.api.v1000.oauth2;
        waited += step;
        if (found || waited >= waitMs) {
          clearInterval(tick);
          resolve(found || null);
        }
      }, step);
    });
  }

  /** Double-submit token handed out with the session read; the endpoint refuses without it. */
  var currentCsrf = '';

  function post(path, body) {
    var headers = { 'content-type': 'application/json' };
    if (currentCsrf !== '') headers['x-vh-csrf'] = currentCsrf;
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: headers,
      body: JSON.stringify(body),
    });
  }

  function report(answer) {
    return post(VERIFY_PATH, answer).catch(function () {});
  }

  function run() {
    return fetch(SESSION_PATH, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (cfg) {
        if (cfg && typeof cfg.csrf === 'string') currentCsrf = cfg.csrf;
        // Nothing to prove: either there is no session yet (the sign-in page owns
        // that path) or this navigation was already answered.
        if (!cfg || cfg.authenticated !== true || cfg.check !== true) return undefined;
        return bridge(BRIDGE_WAIT_MS).then(function (oauth2) {
          if (!oauth2) return report({ skipped: true, reason: 'no-bridge' });
          var verifier = rand();
          var state = rand();
          return sha256Bytes(new TextEncoder().encode(verifier))
            .then(function (digest) {
              return withTimeout(oauth2.authorize({
                client_id: cfg.clientId,
                response_type: 'code',
                scope: cfg.scope,
                state: state,
                nonce: rand(),
                code_challenge: b64(digest),
                code_challenge_method: 'S256',
              }), EXCHANGE_WAIT_MS, 'authorize');
            })
            .then(function (authorized) {
              if (!authorized || authorized.state !== state) throw new Error('state mismatch');
              return withTimeout(oauth2.token({
                grant_type: 'authorization_code',
                code: authorized.code,
                code_verifier: verifier,
                client_id: cfg.clientId,
              }), EXCHANGE_WAIT_MS, 'token');
            })
            .then(function (tokens) {
              if (!tokens || !tokens.access_token) throw new Error('no access token');
              return post(VERIFY_PATH, {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                expires_in: tokens.expires_in,
              });
            })
            .then(function (response) { return response.json(); })
            .then(function (answer) {
              // A different account is signed in on this browser: this document
              // belongs to the previous one and cannot be patched into the new
              // tenant. Reloading is the whole point of the check.
              if (answer && answer.same === false) location.reload();
            });
        });
      })
      .catch(function () { return report({ skipped: true, reason: 'failed' }); });
  }

  try {
    run();
  } catch (error) {
    report({ skipped: true, reason: 'threw' });
  }
}());
