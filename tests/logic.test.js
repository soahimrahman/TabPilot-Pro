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

test('isAudibleOrRecent protects tabs currently audible and tabs in the 90s grace period', () => {
  const recentAudibleTabs = new Map();
  const AUDIBLE_COOLDOWN_MS = 90000;

  function isAudibleOrRecent(tab, protectAudible, now = Date.now()) {
    if (!protectAudible) return false;
    if (tab.audible) {
      recentAudibleTabs.set(tab.id, now);
      return true;
    }
    const lastAudible = recentAudibleTabs.get(tab.id);
    if (lastAudible && (now - lastAudible) < AUDIBLE_COOLDOWN_MS) {
      return true;
    }
    return false;
  }

  const tabId = 101;
  const now = 1000000;

  // Active audio
  assert.equal(isAudibleOrRecent({ id: tabId, audible: true }, true, now), true);

  // Audio paused 30s ago (within 90s cooldown) - meeting silence or song pause
  assert.equal(isAudibleOrRecent({ id: tabId, audible: false }, true, now + 30000), true);

  // Audio paused 100s ago (beyond 90s cooldown)
  assert.equal(isAudibleOrRecent({ id: tabId, audible: false }, true, now + 100000), false);

  // Feature turned off
  assert.equal(isAudibleOrRecent({ id: tabId, audible: true }, false, now), false);
});

test('cache retention keeps live keys and recently restored keys for back-button resilience', () => {
  const now = Date.now();
  const liveKeys = new Set(['key-live-1']);
  const cache = {
    'key-live-1': { url: 'https://example.com/1', title: 'Live Tab' },
    'key-restored-recent': { url: 'https://example.com/2', title: 'Recent Restored', restoredAt: now - 300000 }, // 5 mins ago
    'key-restored-old': { url: 'https://example.com/3', title: 'Old Restored', restoredAt: now - 2000000 }, // > 30 mins ago
    'key-dead': { url: 'https://example.com/4', title: 'Dead Tab' }
  };

  const next = {};
  for (const [key, value] of Object.entries(cache)) {
    const isLive = liveKeys.has(key);
    const isRecentRestore = value.restoredAt && (now - value.restoredAt < 1800000);
    if (isLive || isRecentRestore) next[key] = value;
  }

  assert.ok(next['key-live-1'], 'Currently sleeping live keys should be retained');
  assert.ok(next['key-restored-recent'], 'Recently restored keys should be retained for back-button resilience');
  assert.equal(next['key-restored-old'], undefined, 'Old restored keys (>30m) should be pruned');
  assert.equal(next['key-dead'], undefined, 'Dead unreferenced keys should be pruned');
});

test('compareSemver accurately compares release versions', () => {
  function compareSemver(v1, v2) {
    const p1 = String(v1 || '0').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const p2 = String(v2 || '0').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const num1 = p1[i] || 0;
      const num2 = p2[i] || 0;
      if (num1 > num2) return 1;
      if (num1 < num2) return -1;
    }
    return 0;
  }

  assert.equal(compareSemver('3.2.6', '3.2.5'), 1, 'Newer patch version should detect update');
  assert.equal(compareSemver('3.3.0', '3.2.5'), 1, 'Newer minor version should detect update');
  assert.equal(compareSemver('4.0.0', '3.2.5'), 1, 'Newer major version should detect update');
  assert.equal(compareSemver('v3.2.6', '3.2.5'), 1, 'Prefixed v should parse correctly');
  assert.equal(compareSemver('3.2.5', '3.2.5'), 0, 'Equal versions should return 0');
  assert.equal(compareSemver('3.2.4', '3.2.5'), -1, 'Older version should return -1');
  assert.equal(compareSemver('3.2', '3.2.0'), 0, 'Shorter versions should match zero-padded');
});
