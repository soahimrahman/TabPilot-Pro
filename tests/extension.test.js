const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('manifest.json is valid Manifest V3 and contains required assets', () => {
  const manifestPath = path.join(ROOT, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json should exist');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3, 'Must be Manifest V3');
  assert.ok(manifest.name, 'Name should be specified');
  assert.ok(manifest.version, 'Version should be specified');
  assert.ok(manifest.description, 'Description should be specified');

  // Verify permissions
  const expectedPermissions = ['tabs', 'storage', 'alarms', 'declarativeNetRequest', 'sessions'];
  for (const perm of expectedPermissions) {
    assert.ok(manifest.permissions.includes(perm), `Permission ${perm} should be declared`);
  }

  // Verify service worker
  const swPath = path.join(ROOT, manifest.background.service_worker);
  assert.ok(fs.existsSync(swPath), 'service-worker.js should exist');

  // Verify icons
  for (const [size, iconRelPath] of Object.entries(manifest.icons)) {
    const iconPath = path.join(ROOT, iconRelPath);
    assert.ok(fs.existsSync(iconPath), `Icon ${size}px should exist at ${iconRelPath}`);
  }

  // Verify action popup
  const popupPath = path.join(ROOT, manifest.action.default_popup);
  assert.ok(fs.existsSync(popupPath), 'popup.html should exist');

  // Verify options page
  const optionsPath = path.join(ROOT, manifest.options_page);
  assert.ok(fs.existsSync(optionsPath), 'dashboard.html should exist');
});

test('commands are registered for keyboard shortcuts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.ok(manifest.commands, 'commands object should be present');
  assert.ok(manifest.commands['open-dashboard'], 'open-dashboard command should exist');
  assert.ok(manifest.commands['toggle-keep-awake'], 'toggle-keep-awake command should exist');
  assert.ok(manifest.commands['sleep-other-tabs'], 'sleep-other-tabs command should exist');
});

test('sleep screen assets exist and are linked correctly', () => {
  const sleepHtml = fs.readFileSync(path.join(ROOT, 'sleep.html'), 'utf8');
  assert.ok(fs.existsSync(path.join(ROOT, 'sleep.css')), 'sleep.css should exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'sleep.js')), 'sleep.js should exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'sleep-icon.svg')), 'sleep-icon.svg should exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'sleep-icon.png')), 'sleep-icon.png should exist');

  assert.match(sleepHtml, /sleep-icon\.svg/, 'sleep.html should reference sleep-icon.svg');
  assert.match(sleepHtml, /sleep\.css/, 'sleep.html should reference sleep.css');
  assert.match(sleepHtml, /sleep\.js/, 'sleep.html should reference sleep.js');
});

test('dashboard and popup html link valid scripts and stylesheets', () => {
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const dashboardHtml = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

  assert.ok(fs.existsSync(path.join(ROOT, 'shared.css')), 'shared.css should exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'popup.css')), 'popup.css should exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'popup.js')), 'popup.js should exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'dashboard.css')), 'dashboard.css should exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'dashboard.js')), 'dashboard.js should exist');

  assert.match(popupHtml, /popup\.js/, 'popup.html should link popup.js');
  assert.match(dashboardHtml, /dashboard\.js/, 'dashboard.html should link dashboard.js');
});

