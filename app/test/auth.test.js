'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../lib/auth');
const A = require('../lib/asterisk');

test('passwords hash with scrypt and verify only when right', () => {
  const data = { users: [] };
  const u = auth.setPassword(data, 'dada', 'CorrectHorse1!', 'admin', 'test');
  assert.equal(u.role, 'admin');
  assert.equal(u.hash.length, 128);
  assert.ok(auth.verifyPassword(u, 'CorrectHorse1!'));
  assert.ok(!auth.verifyPassword(u, 'correcthorse1!'));
  assert.throws(() => auth.setPassword(data, 'x', 'short', 'viewer'), /at least 10/);
  assert.throws(() => auth.setPassword(data, 'Bad Name', 'LongEnough1!', 'viewer'), /user name/);
  assert.throws(() => auth.setPassword(data, 'ok', 'LongEnough1!', 'king'), /role/);
});

test('session tokens round-trip, expire and resist tampering', () => {
  const key = 'k'.repeat(64);
  const t = auth.makeToken(key, 'dada', 1);
  assert.equal(auth.readToken(key, t).name, 'dada');
  assert.equal(auth.readToken('other-key', t), null);
  assert.equal(auth.readToken(key, t.slice(0, -2) + 'zz'), null);
  assert.equal(auth.readToken(key, auth.makeToken(key, 'dada', -1)), null);
  assert.equal(auth.readToken(key, ''), null);
  assert.equal(auth.readToken(key, 'garbage'), null);
});

test('roles order viewer < editor < admin', () => {
  assert.ok(auth.roleAtLeast('admin', 'editor'));
  assert.ok(auth.roleAtLeast('editor', 'editor'));
  assert.ok(!auth.roleAtLeast('viewer', 'editor'));
  assert.ok(!auth.roleAtLeast('nobody', 'viewer'));
});

test('engine output parsers read the real CLI formats', () => {
  const ep = A.parseEndpoints([
    ' Endpoint:  <Endpoint/CID.....................................>  <State.....>  <Channels.>',
    ' Endpoint:  1101/1101                                            Unavailable   0 of 1',
    ' Endpoint:  3901/3901                                            Not in use    0 of 1',
    ' Endpoint:  3902/"ICT B" <3902>                                  In use        1 of 1',
    'Objects found: 3'
  ].join('\n'));
  assert.deepEqual(ep.map(e => e.ext + ':' + e.state), ['1101:Unavailable', '3901:Not in use', '3902:In use']);
  const ct = A.parseContacts('  Contact:  3901/sip:3901@10.2.1.55:5061;transport=tls         1a2b3c4d5e Avail        12.345\n  Contact:  3902/sip:3902@203.0.113.7:51234;transport=tls  deadbeef00 NonQual      nan\n');
  assert.equal(ct.length, 2);
  assert.equal(ct[0].host, '10.2.1.55');
  assert.equal(ct[0].rtt, 12.345);
  assert.equal(ct[1].status, 'NonQual');
  assert.equal(ct[1].rtt, null);
});

test('sign-in pauses: a limit of 0 switches the pause off; any other limit still pauses', () => {
  const H = require('../lib/httpx');
  const off = new H.BanList(0, 900, 900);
  for (let i = 0; i < 50; i++) off.fail('john.yang');
  assert.equal(off.isBanned('john.yang'), false, 'switched off: never paused');
  const on = new H.BanList(5, 900, 900);
  for (let i = 0; i < 4; i++) on.fail('x');
  assert.equal(on.isBanned('x'), false, 'four wrong: not yet');
  on.fail('x');
  assert.equal(on.isBanned('x'), true, 'control: the fifth pauses when the limit is 5');
  const { makeEnv } = require('./helpers');
  const a = makeEnv({ accountBanAfter: 0 }), b = makeEnv({});
  try { assert.equal(a.cfg.accountBanAfter, 0, '0 stays 0: off'); assert.equal(b.cfg.accountBanAfter, 5, 'unset: the default 5'); }
  finally { a.cleanup(); b.cleanup(); }
});
