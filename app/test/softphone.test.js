'use strict';
// The browser phone's server side: the phone role, its credentials route, linking a user to an extension, and the
// WebSocket gate in front of the engine. The engine end of /ws is a fake that records what reached it.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { haveOpenssl, makeEnv, listening, request } = require('./helpers');
const { start } = require('../server');
const auth = require('../lib/auth');

const skip = haveOpenssl() ? false : 'openssl is not available to make a test certificate';

// a stand-in for Asterisk's loopback HTTP server: answers the upgrade, then echoes, and keeps what it was sent
function fakeEngineWs() {
  const seen = [];
  const server = net.createServer(sock => {
    let buf = '';
    let upgraded = false;
    sock.on('data', chunk => {
      if (upgraded) { sock.write(chunk); return; }
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.slice(0, end);
      seen.push(head);
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)[1];
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: sip\r\n\r\n');
      upgraded = true;
      const rest = buf.slice(end + 4);
      if (rest) sock.write(Buffer.from(rest, 'latin1'));
    });
    sock.on('error', () => {});
  });
  return { server, seen };
}

async function boot() {
  const engine = fakeEngineWs();
  await new Promise(r => engine.server.listen(0, '127.0.0.1', r));
  const env = makeEnv({ asterisk: { command: [process.execPath, path.join(__dirname, 'fake-asterisk.js')], timeoutMs: 5000, wsHost: '127.0.0.1', wsPort: engine.server.address().port } });
  process.env.FAKE_PJSIP_FILE = path.join(env.cfg.outDir, 'asterisk', 'pjsip_pmc.conf');
  const users = auth.loadUsers(env.cfg.usersFile);
  auth.setPassword(users, 'admin', 'AdminPassw0rd!', 'admin', 'test');
  auth.setPassword(users, 'nurse', 'NursePassw0rd!', 'phone', 'test');
  auth.setPassword(users, 'viewer', 'ViewerPassw0rd!', 'viewer', 'test');
  auth.saveUsers(env.cfg.usersFile, users);
  const srv = start(env.cfg, { log: () => {} });
  await listening(srv.adminServer);
  await listening(srv.publicServer);
  const A = 'https://127.0.0.1:' + srv.adminServer.address().port;
  const P = 'https://127.0.0.1:' + srv.publicServer.address().port;
  return { env, srv, A, P, engine, stop() { srv.close(); engine.server.close(); env.cleanup(); delete process.env.FAKE_PJSIP_FILE; } };
}
const login = async (A, name, password) => (await request(A, 'POST', '/api/login', { body: { name, password } })).cookie;

// a WebSocket upgrade by hand, so every header is under the test's control -> { status, socket, headers }
function upgrade(base, o) {
  o = o || {};
  const u = new URL(o.path || '/ws', base);
  return new Promise((resolve, reject) => {
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': 'sip' };
    if (o.origin !== null) headers.Origin = o.origin || base;
    if (o.cookie) headers.Cookie = o.cookie;
    const req = https.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers, rejectUnauthorized: false });
    // a socket the test did not ask to keep is closed at once: a gate that wrongly lets one through must fail the
    // assertion, not hang the run with an open connection
    req.on('upgrade', (res, socket) => { if (!o.keep) socket.destroy(); resolve({ status: res.statusCode, socket, headers: res.headers }); });
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject);
    req.end();
  });
}

test('browser phone: role, credentials, phone book, linking, and the /ws gate', { skip, timeout: 60000 }, async t => {
  const { A, P, engine, stop } = await boot();
  t.after(stop);
  const adminC = await login(A, 'admin', 'AdminPassw0rd!');

  // the page itself
  let r = await request(A, 'GET', '/phone');
  assert.equal(r.status, 200); assert.match(r.text, /PMC Phone/); assert.match(r.text, /sip\.js/);
  r = await request(A, 'GET', '/sip.js');
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /javascript/);

  // a browser-phone extension, and a desk-phone one to prove the model matters
  r = await request(A, 'POST', '/api/extensions', { cookie: adminC, body: { name: 'Nurse Browser', dept: 'Nursing', model: 'webphone' } });
  assert.equal(r.status, 200, r.text);
  const webExt = r.json.ext;
  r = await request(A, 'GET', '/api/models', { cookie: adminC });
  assert.equal(r.json.webphone.label, 'PMC browser phone (no install)');

  // linking: only four digits that exist
  r = await request(A, 'PUT', '/api/users/nurse', { cookie: adminC, body: { ext: '12' } });
  assert.equal(r.status, 400);
  r = await request(A, 'PUT', '/api/users/nurse', { cookie: adminC, body: { ext: '1999' } });
  assert.equal(r.status, 404);
  r = await request(A, 'PUT', '/api/users/nurse', { cookie: adminC, body: { ext: webExt } });
  assert.equal(r.status, 200, r.text);
  r = await request(A, 'GET', '/api/users', { cookie: adminC });
  assert.equal(r.json.find(u => u.name === 'nurse').ext, webExt);

  // the phone role sees its phone and the phone book, and nothing of the directory
  const nurseC = await login(A, 'nurse', 'NursePassw0rd!');
  r = await request(A, 'GET', '/api/me', { cookie: nurseC });
  assert.equal(r.json.role, 'phone'); assert.equal(r.json.ext, webExt);
  r = await request(A, 'GET', '/api/directory', { cookie: nurseC });
  assert.equal(r.status, 403, 'a phone user cannot read the directory');
  r = await request(A, 'GET', '/api/users', { cookie: nurseC });
  assert.equal(r.status, 403);
  r = await request(A, 'GET', '/api/phonebook', { cookie: nurseC });
  assert.equal(r.status, 200);
  assert.ok(r.json.extensions.some(e => e.ext === webExt && e.name === 'Nurse Browser'));
  assert.ok(r.json.extensions.every(e => Object.keys(e).sort().join() === 'dept,ext,name'), 'the phone book carries no MAC and no secret');

  // credentials: not before Apply creates the password, then exactly this extension's
  r = await request(A, 'GET', '/api/softphone', { cookie: nurseC });
  assert.equal(r.status, 409); assert.match(r.json.error, /Apply/);
  r = await request(A, 'POST', '/api/apply', { cookie: adminC });
  assert.equal(r.status, 200, r.text);
  r = await request(A, 'GET', '/api/softphone', { cookie: nurseC });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ext, webExt); assert.equal(r.json.wsPath, '/ws');
  assert.ok(typeof r.json.password === 'string' && r.json.password.length >= 16);
  // linked to a desk phone instead: refused, with the reason
  r = await request(A, 'PUT', '/api/users/nurse', { cookie: adminC, body: { ext: '3901' } });
  r = await request(A, 'GET', '/api/softphone', { cookie: nurseC });
  assert.equal(r.status, 409); assert.match(r.json.error, /not the browser phone/);
  await request(A, 'PUT', '/api/users/nurse', { cookie: adminC, body: { ext: webExt } });

  // the generated engine config: a ws transport, and the webrtc template for this extension only
  const fs = require('fs');
  const pjsip = fs.readFileSync(process.env.FAKE_PJSIP_FILE, 'utf8');
  assert.match(pjsip, /\[transport-ws\]\ntype=transport\nprotocol=ws/);
  assert.match(pjsip, new RegExp('\\[' + webExt + '\\]\\(pmc-webrtc\\)'));
  assert.match(pjsip, /\[pmc-webrtc\]\(!\)[\s\S]*?webrtc=yes/);
  assert.match(pjsip, /\[3901\]\(pmc-endpoint\)/, 'a desk phone keeps the TLS template');

  // ----- the /ws gate. Each of these must be refused, and none may reach the engine
  const before = engine.seen.length;
  let w = await upgrade(A, {});
  assert.equal(w.status, 401, 'no session');
  w = await upgrade(A, { cookie: nurseC, origin: 'https://evil.example' });
  assert.equal(w.status, 403, 'a page on another site');
  w = await upgrade(A, { cookie: nurseC, origin: null });
  assert.equal(w.status, 403, 'no Origin at all');
  const viewerC = await login(A, 'viewer', 'ViewerPassw0rd!');
  w = await upgrade(A, { cookie: viewerC });
  assert.equal(w.status, 403, 'signed in, but no linked phone');
  w = await upgrade(A, { cookie: nurseC, path: '/ari' });
  assert.equal(w.status, 404, 'only /ws');
  w = await upgrade(P, { cookie: nurseC });
  assert.equal(w.status, 404, 'the public listener never upgrades');
  assert.equal(engine.seen.length, before, 'nothing refused reached the engine');

  // ----- the one that must pass: through to the engine, cookie stripped, subprotocol kept, bytes both ways
  w = await upgrade(A, { cookie: nurseC, keep: true });
  const kept = w.socket;
  t.after(() => { if (kept) kept.destroy(); });   // closed even when an assertion below fails
  assert.equal(w.status, 101);
  assert.equal(w.headers['sec-websocket-protocol'], 'sip');
  const head = engine.seen[engine.seen.length - 1];
  assert.match(head, /^GET \/ws HTTP\/1\.1/);
  assert.doesNotMatch(head, /cookie/i, 'the session cookie never reaches the engine');
  assert.match(head, /Sec-WebSocket-Protocol: sip/);
  const echoed = await new Promise(resolve => { w.socket.once('data', d => resolve(d.toString())); w.socket.write('ping-through'); });
  assert.equal(echoed, 'ping-through');
  w.socket.destroy();

  // a disabled user loses the phone at once
  await request(A, 'PUT', '/api/users/nurse', { cookie: adminC, body: { disabled: true } });
  w = await upgrade(A, { cookie: nurseC });
  assert.equal(w.status, 401, 'disabled');
});
