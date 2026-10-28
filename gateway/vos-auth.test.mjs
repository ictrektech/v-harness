import { test } from 'node:test';
import assert from 'node:assert/strict';

const { identityFromPayload, normalizeLanguage } = await import('./vos-auth.mjs');

/** One VOS userinfo body with the required subject claim. */
function payload(extra = {}) {
  return { sub: 'user-1', preferred_username: 'rui', ...extra };
}

test('narrows BCP 47 tags to the languages the product ships', () => {
  assert.equal(normalizeLanguage('zh-CN'), 'zh');
  assert.equal(normalizeLanguage('zh_TW'), 'zh');
  assert.equal(normalizeLanguage('en-US'), 'en');
  assert.equal(normalizeLanguage('fr-FR'), '');
  assert.equal(normalizeLanguage(undefined), '');
});

test('reads the interface language VOS reports', () => {
  assert.equal(identityFromPayload(payload({ locale: 'en-GB' })).locale, 'en');
  assert.equal(identityFromPayload(payload({ language: 'zh-CN' })).locale, 'zh');
});

test('falls back to the ordered browser tags when userinfo names no language', () => {
  assert.equal(identityFromPayload(payload(), ['fr-FR', 'zh-CN', 'en']).locale, 'zh');
  assert.equal(identityFromPayload(payload(), []).locale, '');
});

test('an unsupported claim does not mask the browser fallback', () => {
  assert.equal(identityFromPayload(payload({ locale: 'de-DE' }), ['en-US']).locale, 'en');
});
