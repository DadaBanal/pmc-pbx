'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../lib/validate');
const G = require('../lib/generate');

const fixture = require('./fixture');
const sample = fixture.directory();
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

test('the browser phone sends its audio from a LAN address, never loopback (13 Oct 2026: no audio either way)', () => {
  const d = V.normalizeDirectory(sample);
  d.extensions.push(V.normalizeExtension({ ext: '3950', name: 'Web', dept: 'ICT', model: 'webphone' }));
  const secrets = { sip: {}, prov: {} };
  G.ensureSecrets(d, secrets);
  const tmpl = p => (/\[pmc-webrtc\]\(!\)\n([\s\S]*?)\n\n/.exec(p) || [])[1] || '';
  const live = c => Object.assign({}, cfg, { webrtcMediaAddress: undefined }, c);
  // the phone site's address first: that is the address phones are proven to reach, and the one forwarded from outside
  let t = tmpl(G.renderPjsip(d, live({ admin: { host: '10.2.0.10', port: 8443 }, phoneSite: { host: '10.2.0.11', port: 443 } }), secrets));
  assert.match(t, /^media_address=10\.2\.0\.11$/m);
  assert.match(t, /^bind_rtp_to_media_address=yes$/m);
  t = tmpl(G.renderPjsip(d, live({ admin: { host: '10.2.0.10', port: 8443 } }), secrets));
  assert.match(t, /^media_address=10\.2\.0\.10$/m, 'no phone site: the admin listener address');
  t = tmpl(G.renderPjsip(d, live({ admin: { host: '10.2.0.10' }, phoneSite: { host: '10.2.0.11' }, webrtcMediaAddress: '10.2.0.12' }), secrets));
  assert.match(t, /^media_address=10\.2\.0\.12$/m, 'an explicit address wins');
  // derived loopback or wildcard is the fault itself: no media line, and the directory is REFUSED, not applied
  for (const host of ['127.0.0.1', '0.0.0.0', 'localhost', '']) {
    const c = live({ admin: { host } });
    assert.doesNotMatch(tmpl(G.renderPjsip(d, c, secrets)), /media_address=/, host);
    assert.ok(V.validateDirectory(d, c).some(p => /need a media address/.test(p)), 'refused for admin.host ' + JSON.stringify(host));
  }
  // control: an explicit loopback (a one-machine test box) is accepted, and the template was found at all
  assert.equal(V.validateDirectory(d, live({ admin: { host: '127.0.0.1' }, webrtcMediaAddress: '127.0.0.1' })).filter(p => /media address/.test(p)).length, 0);
  assert.match(tmpl(G.renderPjsip(d, live({ admin: { host: '127.0.0.1' } }), secrets)), /^webrtc=yes$/m);
});

test('a browser phone is reachable only through the app gate, and a vanished browser does not hold a call open', () => {
  const d = V.normalizeDirectory(sample);
  d.extensions.push(V.normalizeExtension({ ext: '3950', name: 'Web', dept: 'ICT', model: 'webphone' }));
  const secrets = { sip: {}, prov: {} };
  G.ensureSecrets(d, secrets);
  const p = G.renderPjsip(d, Object.assign({}, cfg, { webrtcMediaAddress: '10.2.0.11' }), secrets);
  const web = (/\[pmc-webrtc\]\(!\)\n([\s\S]*?)\n\n/.exec(p) || [])[1];
  const desk = (/\[pmc-endpoint\]\(!\)\n([\s\S]*?)\n\n/.exec(p) || [])[1];
  assert.match(web, /^deny=0\.0\.0\.0\/0\.0\.0\.0$/m);
  assert.match(web, /^permit=127\.0\.0\.1\/255\.255\.255\.255$/m);
  assert.match(web, /^rtp_timeout=30$/m);
  // control: desk phones register over TLS from the LAN and must NOT carry the loopback-only rule
  assert.ok(desk, 'desk template found');
  assert.doesNotMatch(desk, /permit=127\.0\.0\.1/);
});

test('the audio address is offered to the internet only when a public address is set, and the LAN one is kept', () => {
  const base = Object.assign({}, cfg, { webrtcMediaAddress: undefined, admin: { host: '10.2.0.10' }, phoneSite: { host: '10.2.0.11' } });
  assert.match(G.renderRtp(Object.assign({}, base, { webrtcPublicAddress: '103.144.157.235' })), /^10\.2\.0\.11 => 103\.144\.157\.235,include_local_address$/m);
  // control: nothing set, nothing offered; a malformed address is not written into the engine's config either
  assert.doesNotMatch(G.renderRtp(base), /=>/);
  assert.doesNotMatch(G.renderRtp(Object.assign({}, base, { webrtcPublicAddress: 'phone.pmcne.ph' })), /=>/);
});

test('voicemail: a mailbox for every extension with voicemail on, a stable PIN, and *97 by endpoint', () => {
  const d = V.normalizeDirectory(sample);
  const secrets = { sip: {}, prov: {} };
  G.ensureSecrets(d, secrets);
  const vm = G.renderVoicemail(d, secrets);
  assert.match(vm, /^\[pmc\]$/m);
  const want = d.extensions.filter(e => e.voicemail);
  assert.ok(want.length > 0, 'the sample has voicemail extensions');
  for (const e of want) assert.match(vm, new RegExp('^' + e.ext + ' => \\d{6},', 'm'), e.ext);
  for (const e of d.extensions.filter(x => !x.voicemail)) assert.doesNotMatch(vm, new RegExp('^' + e.ext + ' =>', 'm'), e.ext + ' has voicemail off');
  assert.equal(G.voicemailPin(secrets.sip[want[0].ext]), G.voicemailPin(secrets.sip[want[0].ext]), 'stable');
  assert.notEqual(G.voicemailPin('a'), G.voicemailPin('b'));
  assert.match(G.renderDialplan(d, cfg), /^exten => \*97,1,VoiceMailMain\(\$\{CHANNEL\(endpoint\)\}@pmc,s\)$/m);
  // a ';' in a name would cut the callerid line short: it never survives normalisation
  assert.equal(V.normalizeExtension({ ext: '1000', name: 'Ward; 2' }).name, 'Ward 2');
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

test('dialplan: every device a person is signed in on rings, and conference rooms admit only their owner and transfers', () => {
  const cfg = { ringSeconds: 25 };
  const dp = G.renderDialplan({ version: 1, extensions: [{ ext: '3904', name: 'A', dept: 'ICT' }] }, cfg);
  const lines = dp.split('\n');
  const at = s => lines.findIndex(l => l.includes(s));
  // ring all contacts, with no-device and busy both reaching voicemail
  assert.ok(at('Set(DEVICES=${PJSIP_DIAL_CONTACTS(${EXTEN})})') > at('exten => _[1-8]XXX,1'), 'contacts read inside the extension pattern');
  assert.ok(at('GotoIf($["${DEVICES}" = ""]?unavail)') > at('Set(DEVICES='), 'no device signed in: straight to voicemail');
  assert.match(dp, /^ same => n,Dial\(\$\{DEVICES\},25\)$/m);
  assert.doesNotMatch(dp, /Dial\(PJSIP\/\$\{EXTEN\}/, 'the single-device Dial is gone');
  assert.match(dp, /^ same => n\(unavail\),VoiceMail\(\$\{EXTEN\}@pmc,u\)$/m);
  assert.match(dp, /^ same => n\(busy\),VoiceMail\(\$\{EXTEN\}@pmc,b\)$/m);
  // the room: owner check, then the transfer check, then refusal - in that order, before either ConfBridge
  const owner = at('GotoIf($["${CHANNEL(endpoint)}" = "${OWNER}"]?owner)');
  const guest = at('GotoIf($["${CUT(BLINDTRANSFER,-,1)}" = "PJSIP/${OWNER}"]?guest)');
  const refuse = at(' same => n,Hangup(21)');
  assert.ok(at('exten => _*88XXXX,1') >= 0 && owner > at('exten => _*88XXXX,1') && guest > owner && refuse === guest + 1, 'owner, transfer, else refused');
  assert.ok(at('n(owner),ConfBridge(pmc${OWNER},pmc_bridge,pmc_owner)') > refuse);
  assert.ok(at('n(guest),ConfBridge(pmc${OWNER},pmc_bridge,pmc_guest)') > refuse);
  // the profiles the dialplan names exist in the conference config the repo installs
  const conf = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'asterisk', 'conf', 'confbridge.conf'), 'utf8');
  for (const p of ['pmc_bridge', 'pmc_owner', 'pmc_guest']) assert.match(conf, new RegExp('^\\[' + p + '\\]$', 'm'), p + ' in confbridge.conf');
  assert.match(conf, /^end_marked=yes/m, 'the room closes when its owner leaves');
});

test('emergency calls: *99<ext> only from allowed departments and extensions, and the ringing leg is marked', () => {
  const dir = { version: 1, extensions: [{ ext: '3903', name: 'A', dept: 'ICT' }, { ext: '3920', name: 'B', dept: 'Nursing' }, { ext: '3921', name: 'C', dept: 'Nursing' }] };
  const dp = G.renderDialplan(dir, { ringSeconds: 25, emergency: { departments: ['ICT'], extensions: ['3920'] } });
  const lines = dp.split('\n');
  const at = s => lines.findIndex(l => l.includes(s));
  const callers = lines.slice(at('[pmc-emergency-callers]') + 1).filter(l => l.startsWith('exten =>')).map(l => l.split(/[ ,]/)[2]);
  assert.deepEqual(callers, ['3903', '3920'], 'ICT by department, 3920 by name; 3921 is not allowed');
  const check = at('GotoIf(${DIALPLAN_EXISTS(pmc-emergency-callers,${CHANNEL(endpoint)},1)}?allowed)');
  assert.ok(check > at('exten => _*99XXXX,1') && lines[check + 1] === ' same => n,Hangup(21)', 'checked first, refused otherwise');
  assert.ok(at('Dial(${DEVICES},60,b(pmc-emergency-mark^s^1))') > check, 'rings every device, with the mark');
  assert.match(dp, /^exten => s,1,Set\(PJSIP_HEADER\(add,X-PMC-Priority\)=emergency\)$/m);
  // control: with no one allowed, the callers list is empty and every emergency call is refused
  const none = G.renderDialplan(dir, { ringSeconds: 25, emergency: { departments: [], extensions: [] } }).split('\n');
  assert.equal(none.slice(none.indexOf('[pmc-emergency-callers]') + 1).filter(l => l.startsWith('exten =>')).length, 0);
});
