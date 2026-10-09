'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../lib/validate');
const G = require('../lib/generate');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample', 'directory.json'), 'utf8'));
const cfg = Object.assign(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample', 'config.json'), 'utf8')), { certFile: '/etc/pmc-pbx/secrets/cert.pem', keyFile: '/etc/pmc-pbx/secrets/key.pem' });

test('the sample directory validates and normalization is idempotent', () => {
  const d = V.normalizeDirectory(sample);
  assert.deepEqual(V.validateDirectory(d, cfg), []);
  assert.deepEqual(V.normalizeDirectory(d), d);
});

test('bad entries are refused with a reason each', () => {
  const d = V.normalizeDirectory({
    departments: [{ name: 'A', from: 1000, to: 1999 }, { name: 'B', from: 1500, to: 2500 }],
    extensions: [
      { ext: '12', name: 'short', dept: 'A' },
      { ext: '1001', name: '', dept: 'A', mac: 'zz' },
      { ext: '1002', name: 'wrong dept', dept: 'Nowhere' },
      { ext: '1003', name: 'out of range', dept: 'B' },
      { ext: '1004', name: 'self key', dept: 'A', keys: [{ type: 'blf', ext: '1004' }] },
      { ext: '1005', name: 'unknown key', dept: 'A', keys: [{ type: 'blf', ext: '7777' }] },
      { ext: '1005', name: 'duplicate', dept: 'A', model: 'Rotary' }
    ]
  });
  const p = V.validateDirectory(d, cfg);
  const has = re => assert.ok(p.some(x => re.test(x)), 'expected a problem matching ' + re + ' in: ' + p.join(' | '));
  has(/ranges overlap/); has(/12: extension must be 4 digits/); has(/1001: name missing/); has(/1001: MAC/);
  has(/1002: unknown department/); has(/1003: outside the B range/); has(/1004: button 1 points at itself/);
  has(/1005: button 1 points at unknown extension 7777/); has(/1005: duplicate extension/); has(/model must be one of/);
});

test('MAC separators and case are normalized', () => {
  assert.equal(V.normalizeExtension({ ext: '1000', name: 'x', mac: '00:15:65:AA:BB:CC' }).mac, '001565aabbcc');
});

test('next free extension respects the department range', () => {
  const d = V.normalizeDirectory(sample);
  assert.equal(V.nextFreeExt(d, 'Nursing'), '1000');
  assert.equal(V.nextFreeExt(d, 'ICT'), '3900');
  d.extensions.push(V.normalizeExtension({ ext: '3900', name: 'x', dept: 'ICT' }));
  assert.equal(V.nextFreeExt(d, 'ICT'), '3903');
  assert.equal(V.nextFreeExt(d, ''), '1000');
});

test('secrets are created once and the rendered files carry them', () => {
  const d = V.normalizeDirectory(sample);
  const secrets = { sip: {}, prov: {} };
  assert.equal(G.ensureSecrets(d, secrets), 5);
  assert.equal(G.ensureSecrets(d, secrets), 0);
  assert.equal(secrets.sip['3901'].length, 24);
  const pjsip = G.renderPjsip(d, cfg, secrets);
  assert.match(pjsip, /^\[transport-tls\]$/m);
  assert.match(pjsip, /^bind=0\.0\.0\.0:5061$/m);
  assert.match(pjsip, /^media_encryption=sdes$/m);
  assert.match(pjsip, /^\[3901\]\(pmc-endpoint\)$/m);
  assert.ok(pjsip.includes('password=' + secrets.sip['3901']));
  assert.match(pjsip, /^mailboxes=3901@pmc$/m);
  const dp = G.renderDialplan(d, cfg);
  assert.match(dp, /^exten => 3901,hint,PJSIP\/3901$/m);
  assert.match(dp, /^exten => _\[1-8\]XXX,1,NoOp/m);
  assert.match(dp, /^exten => 911,1,Answer\(\)$/m);
  const yl = require('../lib/phones/yealink');
  const y = yl.perPhoneFile(d.extensions[0], { cfg, dir: d, secrets }).body;
  assert.match(y, /^#!version:1\.0\.0\.1/);
  assert.match(y, /^account\.1\.user_name = 3901$/m);
  assert.match(y, /^account\.1\.sip_server\.1\.transport_type = 2$/m);
  assert.match(y, /^account\.1\.srtp_encryption = 2$/m);
  assert.match(y, /^linekey\.1\.type = 16$/m);
  assert.match(y, /^linekey\.1\.value = 3902$/m);
  assert.match(y, /^linekey\.1\.label = ICT Test Phone B$/m);
  assert.ok(y.includes('static.auto_provision.server.password = ' + secrets.prov['001565aaaa01']));
  const pb = yl.sharedFiles(d.extensions.filter(e => e.mac), { cfg, dir: d, secrets })[0].body;
  assert.match(pb, /<Telephone>1101<\/Telephone>/);
  assert.match(pb, /Nurse Station 1 - Nursing/);
});

test('generate writes the files and a manifest', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcpbx-out-'));
  const d = V.normalizeDirectory(sample);
  d.version = 7;
  const secrets = { sip: {}, prov: {} };
  G.ensureSecrets(d, secrets);
  const m = G.generate(cfg, d, secrets, out);
  assert.equal(m.phones, 2);
  assert.equal(m.extensions, 3);
  assert.equal(m.directoryVersion, 7);
  for (const f of ['asterisk/pjsip_pmc.conf', 'asterisk/extensions_pmc.conf', 'phones/001565aaaa01.cfg', 'phones/001565aaaa02.cfg', 'phones/phonebook.xml', 'manifest.json']) {
    assert.ok(fs.statSync(path.join(out, f)).size > 0, f);
  }
  assert.ok(!fs.existsSync(path.join(out, 'phones', '.cfg')));
  fs.rmSync(out, { recursive: true, force: true });
});
