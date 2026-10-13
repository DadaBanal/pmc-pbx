'use strict';
// Phone users from Active Directory (Dada, 13 Oct 2026: "there should be a separate user list that is link to the ad
// add pmo team on it"), and the phone site with no port in its address ("why still the port"). The directory is a
// stand-in (fake-dc.js) on a pinned TLS certificate, as DND-AD01's self-signed one is pinned on the real server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { haveOpenssl, makeEnv, listening, request } = require('./helpers');
const { fakeDc } = require('./fake-dc');
const ldap = require('../lib/ldap');
const PU = require('../lib/phoneusers');
const { loadConfig } = require('../lib/config');
const { start, applyChanges } = require('../server');
const { Store } = require('../lib/store');
const auth = require('../lib/auth');

const skip = haveOpenssl() ? false : 'openssl is not available to make a test certificate';
const PEOPLE = {
  'ana.reyes': { password: 'Right-Passw0rd', name: 'Ana Reyes', groups: ['PMO Team'] },
  'ben.cruz': { password: 'Right-Passw0rd', name: 'Ben Cruz', groups: ['PMO Team'] },
  'outsider': { password: 'Right-Passw0rd', name: 'Out Sider', groups: [] },
  'locked.one': { password: 'Right-Passw0rd', name: 'Locked One', groups: ['PMO Team'], sub: '775' }
};

async function boot(extra) {
  const env = makeEnv(Object.assign({ ad: { url: 'ldaps://127.0.0.1:1', pin: 'set-below', baseDN: 'DC=pmcne,DC=ph', upnSuffix: '@pmcne.ph', groups: ['PMO Team'], dept: 'ICT', timeoutMs: 3000 },
    phoneSite: { host: '127.0.0.1', port: 0, name: 'phone.test' }, phoneNetworks: ['127.0.0.0/8'] }, extra || {}));
  const cert = fs.readFileSync(env.cfg.certFile), key = fs.readFileSync(env.cfg.keyFile);
  const dc = fakeDc(cert, key, PEOPLE);
  await new Promise(r => dc.server.listen(0, '127.0.0.1', r));
  env.cfg.ad.url = 'ldaps://127.0.0.1:' + dc.server.address().port;
  env.cfg.ad.pin = new crypto.X509Certificate(cert).fingerprint256;
  process.env.FAKE_PJSIP_FILE = path.join(env.cfg.outDir, 'asterisk', 'pjsip_pmc.conf');
  const users = auth.loadUsers(env.cfg.usersFile);
  auth.setPassword(users, 'admin', 'AdminPassw0rd!', 'admin', 'test');
  auth.saveUsers(env.cfg.usersFile, users);
  // a running PBX: the directory has been applied once, so a first sign-in may apply its own new phone
  if (!(extra && extra.neverApplied)) assert.equal((await applyChanges(env.cfg, new Store(env.cfg), 'test')).ok, true);
  const srv = start(env.cfg, { log: () => {} });
  await listening(srv.adminServer); await listening(srv.publicServer); await listening(srv.phoneServer);
  const A = 'https://127.0.0.1:' + srv.adminServer.address().port;
  const F = 'https://127.0.0.1:' + srv.phoneServer.address().port;
  return { env, srv, dc, A, F, stop() { srv.close(); dc.server.close(); env.cleanup(); delete process.env.FAKE_PJSIP_FILE; } };
}
const signIn = (base, name, password) => request(base, 'POST', '/api/login', { body: { name, password } });

function upgrade(base, cookie) {
  const u = new URL('/ws', base);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: u.hostname, port: u.port, path: '/ws', method: 'GET', rejectUnauthorized: false, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      'Sec-WebSocket-Protocol': 'sip', Origin: base, Cookie: cookie || '' } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

test('a typed sign-in name becomes the account name, and nothing else gets through', () => {
  for (const [typed, want] of [['ana.reyes', 'ana.reyes'], ['PMCNE\\Ana.Reyes', 'ana.reyes'], ['ana.reyes@pmcne.ph', 'ana.reyes'], ['  Ana.Reyes ', 'ana.reyes']]) {
    assert.equal(ldap.accountName(typed, '@pmcne.ph'), want, typed);
  }
  for (const bad of ['ana.reyes@gmail.com', '*', 'ana)(cn=*', '', 'a b', '..\\x', 'x'.repeat(70)]) assert.equal(ldap.accountName(bad, '@pmcne.ph'), null, bad);
});

test('config: Windows sign-in refuses to start without a certificate pin; networks must be written as networks', () => {
  const env = makeEnv({});
  const file = path.join(env.conf, 'config.json');
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const withCfg = extra => { fs.writeFileSync(file, JSON.stringify(Object.assign({}, base, extra))); return () => loadConfig(env.conf); };
  try {
    assert.throws(withCfg({ ad: { url: 'ldaps://x', baseDN: 'DC=x', upnSuffix: '@x', groups: ['G'] } }), /ad\.pin is required/);
    assert.throws(withCfg({ phoneNetworks: ['10.2.0.0'] }), /phoneNetworks/);
    assert.doesNotThrow(withCfg({ phoneNetworks: ['10.2.0.0/22'] }), 'control: a proper network is accepted');
    // the start-up failure of 13 Oct: provisioning on 0.0.0.0:443 swallows the phone site's 10.2.0.11:443
    assert.throws(withCfg({ listen: { host: '0.0.0.0', port: 443 }, phoneSite: { host: '10.2.0.11', port: 443 } }), /would hold the same port/);
    assert.throws(withCfg({ listen: { host: '10.2.0.10', port: 443 }, phoneSite: { host: '10.2.0.10', port: 443 } }), /would hold the same port/);
    assert.doesNotThrow(withCfg({ listen: { host: '10.2.0.10', port: 443 }, phoneSite: { host: '10.2.0.11', port: 443 } }), 'control: the live layout is accepted');
  } finally { env.cleanup(); }
});

test('the network check: inside the Default network, and nothing next to it', () => {
  const H = require('../lib/httpx');
  const NET = ['10.2.0.0/22'];
  for (const ip of ['10.2.0.10', '10.2.3.255', '10.2.2.198', '::ffff:10.2.1.7']) assert.equal(H.inNetworks(ip, NET), true, ip);
  // the two Wi-Fi networks, the server network, the next block up, and junk
  for (const ip of ['10.69.68.20', '10.17.80.5', '10.10.0.203', '10.2.4.1', '10.1.255.255', '127.0.0.1', 'fe80::1', '', 'x']) assert.equal(H.inNetworks(ip, NET), false, ip);
});

test('the phone refuses every network it is not enabled on, and the admin screen does not', { skip, timeout: 60000 }, async t => {
  const { A, F, stop } = await boot({ phoneNetworks: ['10.2.0.0/22'] }); // the tests connect from 127.0.0.1: not on it
  t.after(stop);
  let r = await request(F, 'GET', '/phone', { noCsrf: true });
  assert.equal(r.status, 403); assert.match(r.text, /not available on this network/);
  assert.equal((await request(A, 'GET', '/phone', { noCsrf: true })).status, 403);
  r = await signIn(A, 'ana.reyes', 'Right-Passw0rd');
  assert.equal(r.status, 403); assert.match(r.json.error, /not available on this network/);
  assert.equal(await upgrade(A, ''), 403);
  // control: the admin screen still answers from here, and an admin still signs in
  assert.equal((await request(A, 'GET', '/', { noCsrf: true })).status, 200);
  assert.equal((await signIn(A, 'admin', 'AdminPassw0rd!')).status, 200);
});

test('the stand-in directory answers the way DND-AD01 does: every length in long form, 4 bytes', () => {
  // 14 Oct 2026: the real DC sends 0x84 + 4 length bytes even for tiny values; a parser capped at 3 passed every test
  // against short lengths and broke every real sign-in. Guard the stand-in's realism, or the tests prove nothing.
  const { adStyle } = require('./fake-dc');
  const msg = ldap.seq(0x30, [ldap.int(0x02, 1), ldap.seq(0x61, [ldap.tlv(0x0a, Buffer.from([0])), ldap.str(0x04, ''), ldap.str(0x04, '')])]);
  const out = adStyle(msg);
  assert.equal(out[1], 0x84, 'outer length is 4-byte long form');
  const t = ldap.readTlv(out, 0);
  assert.ok(t && t.next === out.length, 'and the client parses it whole');
  const [idT, op] = ldap.children(out, t);
  assert.equal(op.tag, 0x61); assert.equal(ldap.num(out, idT), 1);
});

test('the directory check: password by bind, then group membership; refusals that never reach the directory', { skip, timeout: 30000 }, async () => {
  const env = makeEnv({});
  const cert = fs.readFileSync(env.cfg.certFile), key = fs.readFileSync(env.cfg.keyFile);
  const dc = fakeDc(cert, key, PEOPLE);
  await new Promise(r => dc.server.listen(0, '127.0.0.1', r));
  const ad = { url: 'ldaps://127.0.0.1:' + dc.server.address().port, pin: new crypto.X509Certificate(cert).fingerprint256, baseDN: 'DC=pmcne,DC=ph', upnSuffix: '@pmcne.ph', groups: ['PMO Team'], timeoutMs: 3000 };
  try {
    let r = await ldap.checkPerson(ad, 'ana.reyes', 'Right-Passw0rd');
    assert.deepEqual([r.ok, r.sam, r.name, r.group], [true, 'ana.reyes', 'Ana Reyes', 'PMO Team']);
    assert.equal(dc.seen.binds.at(-1), 'ana.reyes@pmcne.ph');
    r = await ldap.checkPerson(ad, 'ana.reyes', 'wrong');
    assert.deepEqual([r.ok, r.reason], [false, 'wrong password']);
    r = await ldap.checkPerson(ad, 'outsider', 'Right-Passw0rd');
    assert.deepEqual([r.ok, r.reason], [false, 'not in PMO Team']);
    r = await ldap.checkPerson(ad, 'locked.one', 'Right-Passw0rd');
    assert.deepEqual([r.ok, r.reason], [false, 'account locked out']);
    r = await ldap.checkPerson(ad, 'nobody.here', 'x');
    assert.deepEqual([r.ok, r.reason], [false, 'no such user']);

    // an empty password is an anonymous bind that AD calls success: it must never be sent
    const binds = dc.seen.binds.length, conns = dc.seen.connections;
    r = await ldap.checkPerson(ad, 'ana.reyes', '');
    assert.equal(r.ok, false);
    assert.equal(dc.seen.binds.length, binds, 'an empty password reached the directory');
    assert.equal(dc.seen.connections, conns, 'an empty password opened a connection');

    // a certificate that is not the pinned one: refused before the password is sent
    r = await ldap.checkPerson(Object.assign({}, ad, { pin: 'AA:' + ad.pin.slice(3) }), 'ana.reyes', 'Right-Passw0rd');
    assert.deepEqual([r.ok, !!r.unavailable], [false, true]);
    assert.match(r.reason, /does not match the pinned one/);
    assert.equal(dc.seen.binds.length, binds, 'a password was sent to an unpinned certificate');

    // nothing listening: unavailable, not "wrong password"
    r = await ldap.checkPerson(Object.assign({}, ad, { url: 'ldaps://127.0.0.1:1' }), 'ana.reyes', 'Right-Passw0rd');
    assert.deepEqual([r.ok, !!r.unavailable], [false, true]);
  } finally { dc.server.close(); env.cleanup(); }
});

test('phone users: Windows sign-in, their own list, a phone on first sign-in, switched off at once', { skip, timeout: 60000 }, async t => {
  const { env, dc, A, stop } = await boot();
  t.after(stop);

  // first sign-in: on the list, a browser phone in ICT, the engine reloaded with it
  let r = await signIn(A, 'PMCNE\\ana.reyes', 'Right-Passw0rd');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.role, 'phone');
  const ana = r.cookie, ext = r.json.ext;
  assert.match(ext, /^39\d\d$/);
  let list = PU.load(env.cfg).users;
  assert.deepEqual(list.map(u => [u.sam, u.ext, u.name]), [['ana.reyes', ext, 'Ana Reyes']]);
  assert.ok(list[0].lastSignIn);
  assert.equal(auth.loadUsers(env.cfg.usersFile).users.some(u => u.name === 'ana.reyes'), false, 'a phone user leaked into the admin accounts');
  r = await request(A, 'GET', '/api/me', { cookie: ana });
  assert.deepEqual([r.json.name, r.json.display, r.json.ext, r.json.ad], ['ana.reyes', 'Ana Reyes', ext, true]);
  r = await request(A, 'GET', '/api/softphone', { cookie: ana });
  assert.equal(r.status, 200); assert.equal(r.json.ext, ext); assert.ok(r.json.password);
  const audit = fs.readFileSync(env.cfg.auditFile, 'utf8');
  assert.match(audit, /"action":"add phone user"/); assert.match(audit, /"action":"apply"/);
  // a phone user sees nothing of the admin screen, and cannot change a password here
  assert.equal((await request(A, 'GET', '/api/users', { cookie: ana })).status, 403);
  assert.equal((await request(A, 'GET', '/api/directory', { cookie: ana })).status, 403);
  assert.equal((await request(A, 'POST', '/api/password', { cookie: ana, body: { current: 'x', next: 'y' } })).status, 400);

  // second sign-in: same phone, no second extension
  r = await signIn(A, 'ana.reyes@pmcne.ph', 'Right-Passw0rd');
  assert.equal(r.status, 200); assert.equal(r.json.ext, ext);
  assert.equal(PU.load(env.cfg).users.length, 1);

  // refusals: wrong password, not in the group, locked; none of them lands on the list
  assert.equal((await signIn(A, 'ana.reyes', 'nope')).status, 401);
  r = await signIn(A, 'outsider', 'Right-Passw0rd');
  assert.equal(r.status, 403); assert.match(r.json.error, /not on the phone list/);
  r = await signIn(A, 'locked.one', 'Right-Passw0rd');
  assert.equal(r.status, 401); assert.match(r.json.error, /locked out/);
  assert.deepEqual(PU.load(env.cfg).users.map(u => u.sam), ['ana.reyes']);

  // the admin's own account is not looked up in the directory at all
  const binds = dc.seen.binds.length;
  const adminC = (await signIn(A, 'admin', 'AdminPassw0rd!')).cookie;
  assert.ok(adminC);
  assert.equal(dc.seen.binds.length, binds, 'an admin-screen sign-in went to the directory');

  // the admin screen lists them, and switching off works at once: the live session, the WebSocket, and sign-in
  r = await request(A, 'GET', '/api/phone-users', { cookie: adminC });
  assert.deepEqual(r.json.users.map(u => u.sam), ['ana.reyes']); assert.deepEqual(r.json.ad.groups, ['PMO Team']);
  // no engine runs in these tests: 502 means the gate let the phone through to where the engine would be
  assert.equal(await upgrade(A, ana), 502, 'control: the live phone user gets through the gate before being switched off');
  assert.equal((await request(A, 'PUT', '/api/phone-users/ana.reyes', { cookie: adminC, body: { disabled: true } })).status, 200);
  assert.equal((await request(A, 'GET', '/api/me', { cookie: ana })).status, 401);
  assert.equal(await upgrade(A, ana), 401);
  r = await signIn(A, 'ana.reyes', 'Right-Passw0rd');
  assert.equal(r.status, 403); assert.match(r.json.error, /switched off/);
  await request(A, 'PUT', '/api/phone-users/ana.reyes', { cookie: adminC, body: { disabled: false } });
  assert.equal((await signIn(A, 'ana.reyes', 'Right-Passw0rd')).status, 200);
});

test('the phone site: no port, the phone only, never the admin screen', { skip, timeout: 60000 }, async t => {
  const { A, F, stop } = await boot();
  t.after(stop);
  let r = await request(F, 'GET', '/', { noCsrf: true });
  assert.equal(r.status, 302); assert.equal(r.headers.location, '/phone');
  for (const p of ['/phone', '/phone.js', '/sip.js', '/style.css', '/manifest.webmanifest', '/sw.js', '/icons/phone-192.png']) {
    assert.equal((await request(F, 'GET', p, { noCsrf: true })).status, 200, p);
  }
  for (const p of ['/index.html', '/app.js', '/icons/../index.html']) assert.equal((await request(F, 'GET', p, { noCsrf: true })).status, 404, p);
  // a phone user signs in and gets their phone here
  r = await signIn(F, 'ben.cruz', 'Right-Passw0rd');
  assert.equal(r.status, 200);
  const ben = r.cookie;
  assert.equal((await request(F, 'GET', '/api/softphone', { cookie: ben })).status, 200);
  assert.equal(await upgrade(F, ben), 502, 'through the gate (no engine here)');
  // the phone site, reachable from the internet, never checks an admin-screen password (review 14 Oct 2026)
  const onPhoneSite = await signIn(F, 'admin', 'AdminPassw0rd!');
  assert.equal(onPhoneSite.status, 401); assert.equal(onPhoneSite.cookie, null);
  // and an admin session made on the admin screen still gets no admin API there
  const adminC = (await signIn(A, 'admin', 'AdminPassw0rd!')).cookie;
  assert.ok(adminC, 'control: the same password works on the admin screen');
  assert.equal((await request(F, 'GET', '/api/users', { cookie: adminC })).status, 404);
  assert.equal((await request(F, 'GET', '/api/phone-users', { cookie: adminC })).status, 404);
  assert.equal((await request(F, 'GET', '/api/me', { cookie: adminC })).status, 200, 'control: the phone API does answer an admin here');
  assert.equal(await upgrade(F, ''), 401);
});

test('a first sign-in never pushes someone else\'s waiting changes live', { skip, timeout: 60000 }, async t => {
  const { env, A, stop } = await boot();
  t.after(stop);
  const adminC = (await signIn(A, 'admin', 'AdminPassw0rd!')).cookie;
  // an editor's change saved but not applied
  assert.equal((await request(A, 'POST', '/api/extensions', { cookie: adminC, body: { name: 'Pending Desk', dept: 'Nursing', model: 'T31P', mac: '001565ccdd01' } })).status, 200);
  const before = new Store(env.cfg).loadManifest().directoryVersion;
  const r = await signIn(A, 'ben.cruz', 'Right-Passw0rd');
  assert.equal(r.status, 200);
  assert.equal(new Store(env.cfg).loadManifest().directoryVersion, before, 'nothing was applied');
  assert.equal(PU.find(PU.load(env.cfg), 'ben.cruz').ext, r.json.ext, 'but the person is on the list with a number');
  const sp = await request(A, 'GET', '/api/softphone', { cookie: r.cookie });
  assert.equal(sp.status, 409); assert.match(sp.json.error, /not switched on/);
  // control: on a clean directory the same first sign-in does apply
  await request(A, 'POST', '/api/apply', { cookie: adminC });
  const r2 = await signIn(A, 'ana.reyes', 'Right-Passw0rd');
  assert.equal((await request(A, 'GET', '/api/softphone', { cookie: r2.cookie })).status, 200);
});

test('removing an extension someone is linked to is refused; removing the phone user takes both', { skip, timeout: 60000 }, async t => {
  const { env, A, stop } = await boot();
  t.after(stop);
  const r = await signIn(A, 'ana.reyes', 'Right-Passw0rd');
  const ext = r.json.ext;
  const adminC = (await signIn(A, 'admin', 'AdminPassw0rd!')).cookie;
  const del = await request(A, 'DELETE', '/api/extensions/' + ext, { cookie: adminC });
  assert.equal(del.status, 409); assert.match(del.json.error, /phone user ana\.reyes/);
  assert.equal(await upgrade(A, r.cookie), 502, 'control: still connected before removal (no engine here: 502 = through the gate)');
  assert.equal((await request(A, 'DELETE', '/api/phone-users/ana.reyes', { cookie: adminC })).status, 200);
  assert.equal(PU.find(PU.load(env.cfg), 'ana.reyes'), undefined);
  assert.equal(new Store(env.cfg).loadDirectory().extensions.some(e => e.ext === ext), false, 'the browser phone went with them');
  assert.equal((await request(A, 'GET', '/api/me', { cookie: r.cookie })).status, 401);
});

test('switching a phone user off closes the phone connection that is already open', { skip, timeout: 60000 }, async t => {
  // an engine that accepts the WebSocket, so the connection stays open the way a live phone's does
  const net = require('net');
  const eng = net.createServer(s => { s.on('error', () => {}); s.once('data', d => {
    const key = /sec-websocket-key:\s*(\S+)/i.exec(d.toString('latin1'))[1];
    const CRLF = '\r\n';
    s.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'),
      'Sec-WebSocket-Protocol: sip', '', ''].join(CRLF));
  }); });
  await new Promise(res => eng.listen(0, '127.0.0.1', res));
  const { A, stop } = await boot({ asterisk: { command: [process.execPath, path.join(__dirname, 'fake-asterisk.js')], timeoutMs: 5000, wsHost: '127.0.0.1', wsPort: eng.address().port } });
  t.after(() => { stop(); eng.close(); });
  const r = await signIn(A, 'ana.reyes', 'Right-Passw0rd');
  const adminC = (await signIn(A, 'admin', 'AdminPassw0rd!')).cookie;
  const sock = await new Promise((resolve, reject) => {
    const u = new URL('/ws', A);
    const req = https.request({ hostname: u.hostname, port: u.port, path: '/ws', method: 'GET', rejectUnauthorized: false, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      'Sec-WebSocket-Protocol': 'sip', Origin: A, Cookie: r.cookie } });
    req.on('upgrade', (res, s) => resolve(s));
    req.on('response', res => { res.resume(); reject(new Error('no upgrade: ' + res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  let closed = false;
  sock.on('close', () => { closed = true; }); sock.on('error', () => {});
  await new Promise(res => setTimeout(res, 100));
  assert.equal(closed, false, 'control: the open phone connection stays open while the user is on');
  assert.equal((await request(A, 'PUT', '/api/phone-users/ana.reyes', { cookie: adminC, body: { disabled: true } })).status, 200);
  const t0 = Date.now();
  while (!closed && Date.now() - t0 < 3000) await new Promise(res => setTimeout(res, 20));
  assert.equal(closed, true, 'switching off closed the connection that was already open');
});

// ------------------------------------------------------------------ the AD group sync (Dada, 14 Oct 2026)
test('group sync: adds new members with a phone, is idempotent, follows people out of and back into the groups', { skip, timeout: 60000 }, async () => {
  const env = makeEnv({ ad: { url: 'ldaps://x:1', pin: 'AA', baseDN: 'DC=x', upnSuffix: '@pmcne.ph', groups: ['PMO Team', 'PMC Phone System Users'], dept: 'ICT' } });
  const st = new Store(env.cfg);
  try {
    const team = [{ sam: 'Ana.Reyes', name: 'Ana Reyes', group: 'PMO Team' }, { sam: 'ben.cruz', name: 'Ben Cruz', group: 'PMC Phone System Users' }, { sam: 'cara.lim', name: 'Cara Lim', group: 'PMO Team' }];
    let r = PU.reconcile(env.cfg, st, team, 'ad-sync');
    assert.deepEqual(r.added.map(x => x.split(' ')[0]), ['ana.reyes', 'ben.cruz', 'cara.lim']);
    const dir = st.loadDirectory();
    for (const u of PU.load(env.cfg).users) assert.ok(dir.extensions.some(e => e.ext === u.ext && e.model === 'webphone'), u.sam + ' has a browser phone');
    // second run: nothing changes
    r = PU.reconcile(env.cfg, st, team, 'ad-sync');
    assert.deepEqual([r.added, r.reEnabled, r.disabled, r.refused], [[], [], [], null]);
    // cara leaves the groups: switched off by the sync; ben switched off by PMO ICT by hand
    PU.update(env.cfg, 'ben.cruz', { disabled: true, disabledBy: 'admin' });
    r = PU.reconcile(env.cfg, st, team.filter(m => m.sam !== 'cara.lim'), 'ad-sync');
    assert.deepEqual(r.disabled, ['cara.lim']);
    assert.equal(PU.find(PU.load(env.cfg), 'cara.lim').disabledBy, 'sync');
    // cara comes back: switched on again; ben stays off, because a person switched him off
    r = PU.reconcile(env.cfg, st, team, 'ad-sync');
    assert.deepEqual(r.reEnabled, ['cara.lim']);
    assert.equal(PU.find(PU.load(env.cfg), 'ben.cruz').disabled, true, 'the sync never overrides a hand switch-off');
    // junk in the member list is skipped, not added
    r = PU.reconcile(env.cfg, st, team.concat([{ sam: 'bad name;rm', name: 'x' }]), 'ad-sync');
    assert.deepEqual(r.added, []); assert.equal(r.skipped.length, 1);
  } finally { env.cleanup(); }
});

test('group sync: a failed or partial AD read never switches people off', { skip, timeout: 60000 }, async () => {
  const env = makeEnv({ ad: { url: 'ldaps://x:1', pin: 'AA', baseDN: 'DC=x', upnSuffix: '@pmcne.ph', groups: ['PMO Team'], dept: 'ICT' } });
  const st = new Store(env.cfg);
  try {
    const team = ['a.one', 'b.two', 'c.three', 'd.four'].map(sam => ({ sam, name: sam, group: 'PMO Team' }));
    PU.reconcile(env.cfg, st, team, 'ad-sync');
    let r = PU.reconcile(env.cfg, st, [], 'ad-sync');
    assert.ok(r.refused, 'an empty AD answer is refused');
    assert.equal(PU.load(env.cfg).users.filter(u => u.disabled).length, 0, 'nobody switched off');
    r = PU.reconcile(env.cfg, st, team.slice(0, 1), 'ad-sync');
    assert.ok(r.refused, 'losing 3 of 4 at once is refused');
    assert.equal(PU.load(env.cfg).users.filter(u => u.disabled).length, 0);
    // control: one person leaving at a time is allowed
    r = PU.reconcile(env.cfg, st, team.slice(0, 3), 'ad-sync');
    assert.equal(r.refused, null); assert.deepEqual(r.disabled, ['d.four']);
  } finally { env.cleanup(); }
});

test('the sync command the scheduled task runs: strict input, adds and applies, refuses junk whole', { skip, timeout: 60000 }, async () => {
  const { execFileSync, spawnSync } = require('child_process');
  const env = makeEnv({ ad: { url: 'ldaps://x:1', pin: 'AA', baseDN: 'DC=x', upnSuffix: '@pmcne.ph', groups: ['PMO Team'], dept: 'ICT' } });
  try {
    const run = input => spawnSync(process.execPath, [path.join(__dirname, '..', 'admin.js'), 'sync-members'], {
      input, encoding: 'utf8', env: Object.assign({}, process.env, { PMC_PBX_CONF: env.conf, FAKE_PJSIP_FILE: path.join(env.cfg.outDir, 'asterisk', 'pjsip_pmc.conf') }) });
    // a running PBX: applied once, so the sync may apply what it adds
    process.env.FAKE_PJSIP_FILE = path.join(env.cfg.outDir, 'asterisk', 'pjsip_pmc.conf');
    assert.equal((await applyChanges(env.cfg, new Store(env.cfg), 'test')).ok, true);
    let r = run(JSON.stringify([{ sam: 'ana.reyes', name: 'Ana Reyes', group: 'PMO Team' }]));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /added: ana\.reyes 39\d\d/);
    assert.match(r.stdout, /apply: ok, verified/);
    // junk is refused whole, nothing added
    for (const bad of ['not json', '{"sam":"x"}', JSON.stringify([{ sam: 7 }]), JSON.stringify([{ sam: 'a'.repeat(65) }])]) {
      r = run(bad);
      assert.equal(r.status, 2, 'refused: ' + bad);
    }
    assert.equal(PU.load(env.cfg).users.length, 1);
    // the preview follows the same safety rules as the real run: an empty AD answer switches NOBODY off
    const dry = spawnSync(process.execPath, [path.join(__dirname, '..', 'admin.js'), 'sync-members', '--dry-run'], { input: '[]', encoding: 'utf8',
      env: Object.assign({}, process.env, { PMC_PBX_CONF: env.conf }) });
    assert.equal(dry.status, 0); assert.match(dry.stdout, /would switch off: NOBODY/);
    // a byte-order mark in front of the list, as Windows PowerShell 5.1 sent it on 14 Oct 2026, is accepted
    const bom = spawnSync(process.execPath, [path.join(__dirname, '..', 'admin.js'), 'sync-members', '--dry-run'], { input: '\uFEFF[{"sam":"zed.bom","name":"Z","group":"PMO Team"}]\r\n', encoding: 'utf8',
      env: Object.assign({}, process.env, { PMC_PBX_CONF: env.conf }) });
    assert.equal(bom.status, 0, bom.stderr); assert.match(bom.stdout, /would add: zed\.bom/);
    void execFileSync;
  } finally { env.cleanup(); delete process.env.FAKE_PJSIP_FILE; }
});

test('the sync command reads its input to the end even when it arrives in pieces, as it does over SSH', { skip, timeout: 60000 }, async () => {
  const { spawn } = require('child_process');
  const env = makeEnv({ ad: { url: 'ldaps://x:1', pin: 'AA', baseDN: 'DC=x', upnSuffix: '@pmcne.ph', groups: ['PMO Team'], dept: 'ICT' } });
  try {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'admin.js'), 'sync-members', '--dry-run'], { env: Object.assign({}, process.env, { PMC_PBX_CONF: env.conf }) });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    const json = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ sam: 'user.' + i, name: 'User ' + i + ' Pe\u00f1a', group: 'PMO Team' })));
    child.stdin.write(json.slice(0, 700));
    await new Promise(r => setTimeout(r, 400));            // the rest arrives later, like a second TCP segment
    child.stdin.end(json.slice(700));
    const code = await new Promise(r => child.on('close', r));
    assert.equal(code, 0, err + out);
    assert.match(out, /would add: user\.0, .*user\.39/);
  } finally { env.cleanup(); }
});
