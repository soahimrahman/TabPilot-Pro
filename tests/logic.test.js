const test = require('node:test');
const assert = require('node:assert/strict');

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function isManageableUrl(value) {
  return /^https?:\/\//i.test(value) || /^file:\/\//i.test(value);
}

function sleepPageKeyFromUrl(value, extensionOrigin) {
  try {
    const current = new URL(value);
    const sleepPage = new URL(extensionOrigin + '/sleep.html');
    if (
      current.protocol !== sleepPage.protocol ||
      current.host !== sleepPage.host ||
      current.pathname !== sleepPage.pathname
    ) return null;
    return current.searchParams.get('key') || null;
  } catch (_) {
    return null;
  }
}

test('clamp handles valid, negative, out-of-range and invalid inputs', () => {
  assert.equal(clamp(5, 1, 30, 5), 5);
  assert.equal(clamp(0, 1, 30, 5), 1);
  assert.equal(clamp(50, 1, 30, 5), 30);
  assert.equal(clamp('10', 1, 30, 5), 10);
  assert.equal(clamp('invalid', 1, 30, 5), 5);
  assert.equal(clamp(NaN, 1, 30, 5), 5);
});

test('isManageableUrl identifies regular web and local files, excludes chrome:// and internal schemes', () => {
  assert.equal(isManageableUrl('https://github.com'), true);
  assert.equal(isManageableUrl('http://localhost:3000'), true);
  assert.equal(isManageableUrl('file:///C:/Users/test/doc.html'), true);
  assert.equal(isManageableUrl('chrome://settings'), false);
  assert.equal(isManageableUrl('chrome-extension://xyz/popup.html'), false);
  assert.equal(isManageableUrl('about:blank'), false);
  assert.equal(isManageableUrl('edge://extensions'), false);
});

test('sleepPageKeyFromUrl correctly parses key parameter from extension sleep URL', () => {
  const origin = 'chrome-extension://abcdefghijklmnop';
  const validUrl = `${origin}/sleep.html?key=token-12345`;
  assert.equal(sleepPageKeyFromUrl(validUrl, origin), 'token-12345');

  const otherOrigin = 'chrome-extension://different';
  assert.equal(sleepPageKeyFromUrl(validUrl, otherOrigin), null);

  const regularSite = 'https://example.com/sleep.html?key=token-12345';
  assert.equal(sleepPageKeyFromUrl(regularSite, origin), null);

  assert.equal(sleepPageKeyFromUrl('not-a-url', origin), null);
});
