'use strict';
// PMC Phone as an installed app (Dada, 13 Oct 2026: "well we need a phone app for this"). Edge and Chrome install a
// page as an app only if its manifest, icons and worker are right, and Edge's WebAppInstallForceList policy fetches
// them WITHOUT a sign-in. So: the files are well formed, the phone page points at them, the server hands them out
// before anyone signs in, and the worker turns a dead network into a message instead of a browser error page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { haveOpenssl, makeEnv, listening, request } = require('./helpers');
const { start } = require('../server');

const PUB = path.join(__dirname, '..', 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.webmanifest'), 'utf8'));
const inScope = p => p.startsWith(manifest.scope);

test('the manifest names the app, opens the phone, and stays inside its scope', () => {
  assert.equal(manifest.name, 'PMC Phone');
  assert.equal(manifest.display, 'standalone');
  assert.ok(inScope(manifest.start_url), 'start_url ' + manifest.start_url + ' is outside scope ' + manifest.scope);
  assert.ok(manifest.id, 'an id keeps the installed app the same app when start_url changes');
});

test('every icon exists, is a PNG, and is the size the manifest says', () => {
  const sizes = new Set();
  for (const ic of manifest.icons) {
    const b = fs.readFileSync(path.join(PUB, ic.src));
    assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', ic.src + ' is not a PNG');
    assert.equal(b.readUInt32BE(16) + 'x' + b.readUInt32BE(20), ic.sizes, ic.src + ' is not ' + ic.sizes);
    sizes.add(ic.sizes + ' ' + ic.purpose);
  }
  // Chromium wants a 192 and a 512 to install; Android wants a maskable one so the icon is not boxed
  for (const need of ['192x192 any', '512x512 any', '512x512 maskable']) assert.ok(sizes.has(need), 'missing icon ' + need);
});

test('the phone page links the manifest and registers the worker over the app scope', () => {
  const html = fs.readFileSync(path.join(PUB, 'phone.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  const js = fs.readFileSync(path.join(PUB, 'phone.js'), 'utf8');
  const m = /serviceWorker\.register\('([^']+)', \{ scope: '([^']+)' \}\)/.exec(js);
  assert.ok(m, 'phone.js does not register a service worker');
  assert.equal(m[1], '/sw.js');
  assert.equal(m[2], manifest.scope, 'the worker scope and the manifest scope differ');
  assert.ok(path.posix.dirname(m[1]) === '/' || m[2].startsWith(path.posix.dirname(m[1])), 'the worker cannot control a scope above its own folder');
});

// run sw.js in a sandbox with a stand-in for the browser's worker globals
function loadWorker(fetchImpl) {
  const handlers = {};
  const self = { addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting() {}, clients: { claim: () => Promise.resolve() } };
  vm.runInNewContext(fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8'), { self, fetch: fetchImpl, Response });
  return handlers;
}
const fire = (h, request) => { let answer = null; h.fetch({ request, respondWith: p => { answer = p; } }); return answer; };

test('the worker answers a failed page load with a plain message, and leaves everything else to the network', async () => {
  const h = loadWorker(() => Promise.reject(new TypeError('Failed to fetch')));
  const r = await fire(h, { mode: 'navigate', url: 'https://pbx.pmcne.ph:8443/phone' });
  assert.equal(r.status, 503);
  assert.match(await r.text(), /cannot reach the phone system/);
  assert.equal(fire(h, { mode: 'cors', url: 'https://pbx.pmcne.ph:8443/api/softphone' }), null, 'the worker must not touch API calls');
});

test('control: with the network up, the worker passes the real page through untouched', async () => {
  const real = new Response('the real page', { status: 200 });
  const h = loadWorker(() => Promise.resolve(real));
  assert.equal(await fire(h, { mode: 'navigate', url: 'https://pbx.pmcne.ph:8443/phone' }), real);
});

test('the server hands out the install files before sign-in, with the right types', { skip: haveOpenssl() ? false : 'openssl is not available' }, async () => {
  const env = makeEnv({});
  const srv = start(env.cfg, { log: () => {} });
  try {
    await listening(srv.adminServer); await listening(srv.publicServer);
    const A = 'https://127.0.0.1:' + srv.adminServer.address().port;
    const P = 'https://127.0.0.1:' + srv.publicServer.address().port;
    const want = [['/phone', /^text\/html/], ['/manifest.webmanifest', /^application\/manifest\+json/], ['/sw.js', /^text\/javascript/]]
      .concat(manifest.icons.map(ic => [ic.src, /^image\/png$/]));
    for (const [p, type] of want) {
      const r = await request(A, 'GET', p, { noCsrf: true });
      assert.equal(r.status, 200, p + ' returned ' + r.status + ' without a sign-in');
      assert.match(r.headers['content-type'], type, p + ' served as ' + r.headers['content-type']);
    }
    // control: a file that cannot exist is refused, so the 200s above mean something
    assert.equal((await request(A, 'GET', '/icons/no-such-icon-zz9.png', { noCsrf: true })).status, 404);
    // the Android app's install page, and the APK once the deploy has put it there (14 Oct 2026)
    let r = await request(A, 'GET', '/app', { noCsrf: true });
    assert.equal(r.status, 200); assert.match(r.headers['content-type'], /^text\/html/); assert.match(r.text, /Download the app/);
    const apkDir = path.join(__dirname, '..', 'public', 'app'), apk = path.join(apkDir, 'pmc-phone.apk');
    const had = fs.existsSync(apk);
    if (!had) assert.equal((await request(A, 'GET', '/app/pmc-phone.apk', { noCsrf: true })).status, 404, 'not deployed: nothing to download');
    fs.mkdirSync(apkDir, { recursive: true });
    if (!had) fs.writeFileSync(apk, Buffer.from('PK test'));
    try {
      r = await request(A, 'GET', '/app/pmc-phone.apk', { noCsrf: true });
      assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'application/vnd.android.package-archive');
    } finally { if (!had) fs.unlinkSync(apk); }
    // the internet-facing listener serves phones' files only, never the app
    assert.notEqual((await request(P, 'GET', '/manifest.webmanifest', { noCsrf: true })).status, 200);
  } finally { srv.close(); env.cleanup(); }
});
