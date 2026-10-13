'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { haveOpenssl, makeEnv, listening, request } = require('./helpers');
const { start } = require('../server');
const auth = require('../lib/auth');

const skip = haveOpenssl() ? false : 'openssl is not available to make a test certificate';

async function boot(overrides) {
  const env = makeEnv(overrides);
  process.env.FAKE_PJSIP_FILE = path.join(env.cfg.outDir, 'asterisk', 'pjsip_pmc.conf');
  const users = auth.loadUsers(env.cfg.usersFile);
  auth.setPassword(users, 'admin', 'AdminPassw0rd!', 'admin', 'test');
  auth.setPassword(users, 'editor', 'EditorPassw0rd!', 'editor', 'test');
  auth.setPassword(users, 'viewer', 'ViewerPassw0rd!', 'viewer', 'test');
  auth.saveUsers(env.cfg.usersFile, users);
  const srv = start(env.cfg, { log: () => {} });
  await listening(srv.adminServer);
  await listening(srv.publicServer);
  const A = 'https://127.0.0.1:' + srv.adminServer.address().port;
  const P = 'https://127.0.0.1:' + srv.publicServer.address().port;
  return { env, srv, A, P, stop() { srv.close(); env.cleanup(); delete process.env.FAKE_PJSIP_FILE; delete process.env.FAKE_DOWN; } };
}

test('admin screen API, provisioning and the engine, end to end with a fake engine', { skip }, async t => {
  const { env, A, P, stop } = await boot();
  t.after(stop);

  let r = await request(A, 'GET', '/api/directory');
  assert.equal(r.status, 401, 'no session');
  r = await request(A, 'GET', '/');
  assert.equal(r.status, 200); assert.match(r.text, /PMC Phones/);
  r = await request(A, 'GET', '/app.js');
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /javascript/);
  r = await request(A, 'GET', '/../server.js');
  assert.equal(r.status, 404, 'no path traversal');

  r = await request(A, 'POST', '/api/login', { body: { name: 'admin', password: 'AdminPassw0rd!' }, noCsrf: true });
  assert.equal(r.status, 403, 'write without the CSRF header');
  r = await request(A, 'POST', '/api/login', { body: { name: 'admin', password: 'wrong' } });
  assert.equal(r.status, 401);
  r = await request(A, 'POST', '/api/login', { body: { name: 'Admin', password: 'AdminPassw0rd!' } });
  assert.equal(r.status, 200); assert.equal(r.json.role, 'admin');
  const cookie = r.cookie; assert.ok(cookie && cookie.startsWith('pmcpbx='));
  assert.match(r.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict/);

  r = await request(A, 'GET', '/api/me', { cookie });
  assert.equal(r.json.name, 'admin');
  r = await request(A, 'GET', '/api/directory', { cookie });
  assert.equal(r.json.extensions.length, 3);
  r = await request(A, 'GET', '/api/extensions/next?dept=Nursing', { cookie });
  assert.equal(r.json.ext, '1000');

  r = await request(A, 'POST', '/api/extensions', { cookie, body: { name: 'Nurse Station 2', dept: 'Nursing', mac: '00:15:65:AA:AA:03', voicemail: true, keys: [{ type: 'blf', ext: '1101' }] } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.ext, '1000'); assert.equal(r.json.version, 1);
  r = await request(A, 'POST', '/api/extensions', { cookie, body: { ext: '1000', name: 'Dup', dept: 'Nursing' } });
  assert.equal(r.status, 409);
  r = await request(A, 'POST', '/api/extensions', { cookie, body: { ext: '2500', name: 'Wrong range', dept: 'Nursing' } });
  assert.equal(r.status, 400); assert.match(r.json.error, /outside the Nursing range/);
  r = await request(A, 'POST', '/api/extensions', { cookie, body: { name: 'Bad MAC', dept: 'Nursing', mac: '12' } });
  assert.equal(r.status, 400); assert.match(r.json.error, /MAC/);

  r = await request(A, 'GET', '/api/status', { cookie });
  assert.equal(r.json.engine.state, 'ok'); assert.equal(r.json.pending, true); assert.equal(r.json.appliedVersion, null);

  r = await request(A, 'POST', '/api/apply', { cookie });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.ok, true); assert.equal(r.json.manifest.phones, 3); assert.equal(r.json.manifest.directoryVersion, 1);
  assert.ok(r.json.reload.steps.every(s => s.ok));
  assert.deepEqual(r.json.verified, { endpoints: 4, hints: 4, missingEndpoints: [], missingHints: [] }, 'apply checks what the engine really loaded');

  r = await request(A, 'GET', '/api/status', { cookie });
  assert.equal(r.json.pending, false); assert.equal(r.json.appliedVersion, 1);
  assert.ok(r.json.endpoints.some(e => e.ext === '1000' && e.name === 'Nurse Station 2'), 'the engine shows the new number');
  assert.equal(r.json.registered, 1, 'fake engine reports 3901 online');
  assert.equal(r.json.endpoints.find(e => e.ext === '3901').host, '10.2.1.55');

  const secrets = JSON.parse(fs.readFileSync(env.cfg.secretsFile, 'utf8'));
  const pw = secrets.prov['001565aaaa03']; assert.ok(pw);
  r = await request(P, 'GET', '/prov/001565aaaa03.cfg', { auth: '001565aaaa03:' + pw });
  assert.equal(r.status, 200, r.text); assert.match(r.text, /^account\.1\.user_name = 1000$/m); assert.match(r.text, /^linekey\.1\.value = 1101$/m);
  r = await request(P, 'GET', '/prov/001565aaaa03.cfg', { auth: '001565aaaa03:wrong' });
  assert.equal(r.status, 401);
  r = await request(P, 'GET', '/prov/001565aaaa03.cfg');
  assert.equal(r.status, 401);
  r = await request(P, 'GET', '/prov/phonebook.xml', { auth: '001565aaaa03:' + pw });
  assert.equal(r.status, 200); assert.match(r.text, /Nurse Station 2 - Nursing/);
  r = await request(P, 'GET', '/health');
  assert.equal(r.status, 200); assert.equal(r.json.phones, 3); assert.equal(r.json.appliedVersion, 1); assert.ok(r.json.certDaysLeft >= 1);
  r = await request(P, 'GET', '/api/directory');
  assert.equal(r.status, 404, 'the public listener has no admin API');

  r = await request(A, 'GET', '/api/extensions/1000/provisioning', { cookie });
  assert.equal(r.status, 200); assert.equal(r.json.password, pw); assert.equal(r.json.username, '001565aaaa03'); assert.equal(r.json.applied, true);
  const ed = await request(A, 'POST', '/api/login', { body: { name: 'editor', password: 'EditorPassw0rd!' } });
  r = await request(A, 'GET', '/api/extensions/1000/provisioning', { cookie: ed.cookie });
  assert.equal(r.status, 403, 'editor may not read phone secrets');
  const vw = await request(A, 'POST', '/api/login', { body: { name: 'viewer', password: 'ViewerPassw0rd!' } });
  r = await request(A, 'POST', '/api/extensions', { cookie: vw.cookie, body: { name: 'x', dept: 'Nursing' } });
  assert.equal(r.status, 403, 'viewer may not add');
  r = await request(A, 'GET', '/api/directory', { cookie: vw.cookie });
  assert.equal(r.status, 200, 'viewer may read');

  r = await request(A, 'PUT', '/api/extensions/1000', { cookie: ed.cookie, body: { name: 'Nurse Station 2 East', ext: '9999' } });
  assert.equal(r.status, 200); assert.equal(r.json.ext, '1000', 'the number cannot be changed by an edit');
  r = await request(A, 'DELETE', '/api/extensions/3901', { cookie: ed.cookie });
  assert.equal(r.status, 200);
  r = await request(A, 'GET', '/api/directory', { cookie });
  assert.ok(!r.json.extensions.some(e => e.ext === '3901'));
  assert.ok(r.json.extensions.every(e => e.keys.every(k => k.ext !== '3901')), 'buttons pointing at a removed number are dropped');
  assert.equal(r.json.version, 3);
  r = await request(A, 'GET', '/api/status', { cookie });
  assert.equal(r.json.pending, true, 'edits after an apply are pending again');

  r = await request(A, 'PUT', '/api/departments', { cookie, body: { departments: [{ name: 'A', from: 1000, to: 1999 }, { name: 'B', from: 1500, to: 2500 }] } });
  assert.equal(r.status, 400); assert.match(r.json.error, /overlap/);
  r = await request(A, 'PUT', '/api/departments', { cookie: ed.cookie, body: { departments: [] } });
  assert.equal(r.status, 403, 'editor may not change departments');

  r = await request(A, 'POST', '/api/users', { cookie, body: { name: 'nurse1', role: 'editor', password: 'TempPassw0rd!' } });
  assert.equal(r.status, 200);
  r = await request(A, 'POST', '/api/users', { cookie, body: { name: 'nurse1', role: 'editor', password: 'TempPassw0rd!' } });
  assert.equal(r.status, 409);
  r = await request(A, 'PUT', '/api/users/admin', { cookie, body: { disabled: true } });
  assert.equal(r.status, 400, 'cannot disable yourself');
  r = await request(A, 'PUT', '/api/users/nurse1', { cookie, body: { disabled: true } });
  assert.equal(r.status, 200);
  r = await request(A, 'POST', '/api/login', { body: { name: 'nurse1', password: 'TempPassw0rd!' } });
  assert.equal(r.status, 401, 'disabled user cannot sign in');
  r = await request(A, 'GET', '/api/users', { cookie: ed.cookie });
  assert.equal(r.status, 403);

  r = await request(A, 'POST', '/api/password', { cookie: vw.cookie, body: { current: 'ViewerPassw0rd!', next: 'ViewerNewPassw0rd!' } });
  assert.equal(r.status, 200);
  r = await request(A, 'POST', '/api/login', { body: { name: 'viewer', password: 'ViewerNewPassw0rd!' } });
  assert.equal(r.status, 200);

  r = await request(A, 'GET', '/api/audit', { cookie });
  assert.equal(r.status, 200);
  for (const action of ['sign in', 'add extension', 'apply', 'view phone secrets', 'edit extension', 'remove extension', 'add user', 'edit user', 'change own password']) {
    assert.ok(r.json.some(a => a.action === action), 'audit has ' + action);
  }
  assert.ok(!JSON.stringify(r.json).includes(pw), 'audit never carries a secret');

  const history = fs.readdirSync(env.cfg.historyDir).filter(f => f.startsWith('directory-v'));
  assert.equal(history.length, 3, 'one history copy per saved version');

  r = await request(A, 'POST', '/api/logout', { cookie });
  assert.equal(r.status, 200);

  process.env.FAKE_DOWN = '1';
  r = await request(A, 'POST', '/api/apply', { cookie: ed.cookie });
  assert.equal(r.status, 502, 'engine down is reported, not hidden');
  r = await request(A, 'GET', '/api/status', { cookie: ed.cookie });
  assert.equal(r.json.engine.state, 'unreachable');
  delete process.env.FAKE_DOWN;

  process.env.FAKE_STALE = '1';
  r = await request(A, 'POST', '/api/apply', { cookie: ed.cookie });
  assert.equal(r.status, 502, 'a reload the engine silently ignored is reported as a failure');
  assert.match(r.json.error, /did not load 1 extension\(s\) \[1000\]/);
  assert.deepEqual(r.json.verified.missingEndpoints, ['1000']);
  delete process.env.FAKE_STALE;
  r = await request(A, 'GET', '/api/audit', { cookie });
  assert.ok(r.json.some(a => a.action === 'apply' && /FAILED: engine reloaded but did not load/.test(a.detail)), 'the failed apply is in the history');
});

test('repeated failed sign-ins lock the address out', { skip }, async t => {
  const { A, stop } = await boot({ loginBanAfter: 3, banSec: 60 });
  t.after(stop);
  for (let i = 0; i < 3; i++) {
    const r = await request(A, 'POST', '/api/login', { body: { name: 'admin', password: 'nope' } });
    assert.equal(r.status, 401);
  }
  const r = await request(A, 'POST', '/api/login', { body: { name: 'admin', password: 'AdminPassw0rd!' } });
  assert.equal(r.status, 429, 'even the right password is refused while locked out');
});

// Review 14 Oct 2026: AD lockout is off on this domain, so the app's per-account limit is the only cap on guesses.
test('repeated failed sign-ins for one name cool that name down, and only that name', { skip }, async t => {
  const { A, stop } = await boot({ loginBanAfter: 50, accountBanAfter: 3, accountBanSec: 60 });
  t.after(stop);
  for (let i = 0; i < 3; i++) assert.equal((await request(A, 'POST', '/api/login', { body: { name: 'admin', password: 'nope' } })).status, 401);
  const r = await request(A, 'POST', '/api/login', { body: { name: 'admin', password: 'AdminPassw0rd!' } });
  assert.equal(r.status, 429, 'the right password is refused while the name cools down');
  assert.match(r.json.error, /this name/);
  // control: the address is not banned, so another name still gets a normal answer
  assert.equal((await request(A, 'POST', '/api/login', { body: { name: 'someone-else', password: 'nope' } })).status, 401);
});
