'use strict';
// The phone registry and its drivers: a mixed fleet of Yealink, Avaya and software phones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../lib/validate');
const G = require('../lib/generate');
const phones = require('../lib/phones');

const cfg = Object.assign(
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample', 'config.json'), 'utf8')),
  { certFile: '/etc/pmc-pbx/tls/cert.pem', keyFile: '/etc/pmc-pbx/tls/key.pem' });

const mixed = () => V.normalizeDirectory({
  version: 3,
  departments: [{ name: 'Nursing', from: 1000, to: 1999 }, { name: 'ICT', from: 3900, to: 3999 }],
  extensions: [
    { ext: '3901', name: 'ICT Desk', dept: 'ICT', model: 'T31P', mac: '001565aaaa01', voicemail: true,
      keys: [{ type: 'blf', ext: '1101' }] },
    { ext: '1101', name: 'Corridor West', dept: 'Nursing', model: 'T30P', mac: '001565bbbb01', voicemail: false },
    { ext: '1102', name: 'Ward Desk', dept: 'Nursing', model: 'J179', mac: 'ccddee001122', voicemail: true,
      keys: [{ type: 'blf', ext: '3901' }] },
    { ext: '1103', name: 'Roving Midwife', dept: 'Nursing', model: 'softphone', mac: '', voicemail: true }
  ]
});

test('the registry answers for every model and names its vendor', () => {
  assert.equal(phones.modelSpec('T31P').vendor, 'Yealink');
  assert.equal(phones.modelSpec('T30P').vendor, 'Yealink');
  assert.equal(phones.modelSpec('J179').vendor, 'Avaya');
  assert.equal(phones.modelSpec('softphone').vendor, 'None');
  assert.equal(phones.modelSpec('NoSuchPhone'), null);
  assert.ok(phones.supportsKeys('T31P'));
  assert.ok(phones.supportsKeys('J179'));
  assert.ok(!phones.supportsKeys('T30P'), 'the T30P has no line keys (Yealink support documentation)');
  assert.ok(!phones.supportsKeys('softphone'));
  assert.deepEqual(V.validateDirectory(mixed(), cfg), [], 'a mixed fleet is valid');
});

test('a button on a model with no keys is refused, and too many buttons are refused', () => {
  const d = mixed();
  d.extensions[1].keys = [V.normalizeExtension({ ext: '1101', name: 'x', keys: [{ type: 'blf', ext: '3901' }] }).keys[0]];
  const p = V.validateDirectory(d, cfg);
  assert.ok(p.some(x => /1101: .*no programmable keys/.test(x)), p.join(' | '));

  const d2 = mixed();
  d2.extensions[0].keys = [{ type: 'blf', ext: '1101' }, { type: 'blf', ext: '1102' }, { type: 'blf', ext: '1103' }]
    .map(k => V.normalizeExtension({ ext: '3901', name: 'x', keys: [k] }).keys[0]);
  const p2 = V.validateDirectory(d2, cfg);
  assert.ok(p2.some(x => /3901: .*has 2 key\(s\); 3 are set/.test(x)), p2.join(' | '));
});

test('each vendor gets the files it asks for, and only those', () => {
  const d = mixed();
  const secrets = { sip: {}, prov: {} };
  G.ensureSecrets(d, secrets);

  // a provisioning password exists only where a per-phone file is fetched
  assert.ok(secrets.prov['001565aaaa01'], 'Yealink T31P has one');
  assert.ok(secrets.prov['001565bbbb01'], 'Yealink T30P has one');
  assert.ok(!secrets.prov['ccddee001122'], 'the Avaya fetches a shared file, so it needs no per-MAC password');
  assert.ok(secrets.sip['1102'], 'but it still has a SIP password, which is typed at the handset');

  const files = G.phoneFiles(cfg, d, secrets);
  const names = files.map(f => f.name).sort();
  assert.deepEqual(names, ['001565aaaa01.cfg', '001565bbbb01.cfg', '46xxsettings.txt', 'J100Supgrade.txt', 'phonebook.xml'].sort());
  assert.equal(files.find(f => f.name === 'J100Supgrade.txt').auth, 'lan');
  assert.match(files.find(f => f.name === 'J100Supgrade.txt').body, /^GET 46xxsettings\.txt$/m, 'the upgrade file sends the phone on to its settings');
  assert.doesNotMatch(files.find(f => f.name === 'J100Supgrade.txt').body, /\.bin\b|APPNAME/i, 'and offers no firmware');
  assert.equal(files.find(f => f.name === '46xxsettings.txt').auth, 'lan');
  assert.equal(files.find(f => f.name === '001565aaaa01.cfg').auth, 'per-mac');
  assert.equal(files.find(f => f.name === '001565aaaa01.cfg').mac, '001565aaaa01');
});

test('Yealink: the T31P gets its button, the T30P gets none', () => {
  const d = mixed();
  const secrets = { sip: {}, prov: {} };
  G.ensureSecrets(d, secrets);
  const files = G.phoneFiles(cfg, d, secrets);
  const t31 = files.find(f => f.name === '001565aaaa01.cfg').body;
  const t30 = files.find(f => f.name === '001565bbbb01.cfg').body;

  assert.match(t31, /^linekey\.1\.type = 16$/m);
  assert.match(t31, /^linekey\.1\.value = 1101$/m);
  assert.ok(!/^linekey\./m.test(t30), 'no linekey line may be written to a T30P');
  // the rest of the family's configuration is identical in shape
  for (const line of [/^account\.1\.user_name = 1101$/m, /^account\.1\.sip_server\.1\.transport_type = 2$/m,
    /^account\.1\.srtp_encryption = 2$/m, /^static\.auto_provision\.server\.username = 001565bbbb01$/m]) {
    assert.match(t30, line);
  }
});

test('Avaya: one shared settings file, a branch per handset, and no secret in it', () => {
  const d = mixed();
  const secrets = { sip: {}, prov: {} };
  G.ensureSecrets(d, secrets);
  const f = G.phoneFiles(cfg, d, secrets).find(x => x.name === '46xxsettings.txt').body;

  assert.match(f, /^SET SIP_CONTROLLER_LIST pbx\.pmcne\.ph:5061;transport=tls$/m);
  assert.match(f, /^SET SIPDOMAIN pbx\.pmcne\.ph$/m);
  assert.match(f, /^SET MEDIAENCRYPTION 1$/m, 'SRTP on');
  assert.match(f, /^SET SDPCAPNEG 0$/m, 'the setting Asterisk needs');
  assert.match(f, /^IF \$MACADDR SEQ CCDDEE001122 GOTO PH1$/m, 'Avaya compares upper-case MACs');
  assert.match(f, /^SET PHONE_LABEL "Ward Desk"$/m);
  assert.match(f, /^END$/m);
  // the identity is typed at the handset, so no password may appear in a file every Avaya phone can fetch
  assert.ok(!f.includes(secrets.sip['1102']), 'the SIP password must never be in the shared file');
  for (const v of Object.values(secrets.sip).concat(Object.values(secrets.prov))) assert.ok(!f.includes(v));
});

test('generate writes every file, an index saying how each is guarded, and counts the vendors', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcpbx-mv-'));
  const d = mixed();
  const secrets = { sip: {}, prov: {} };
  G.ensureSecrets(d, secrets);
  const m = G.generate(cfg, d, secrets, out);

  assert.equal(m.phones, 3, 'three handsets have a MAC; the software phone does not');
  assert.equal(m.extensions, 4);
  assert.deepEqual(m.vendors, { Yealink: 2, Avaya: 1 });
  assert.equal(m.files, 5);

  const index = JSON.parse(fs.readFileSync(path.join(out, 'phones', 'index.json'), 'utf8'));
  assert.equal(index['46xxsettings.txt'].auth, 'lan');
  assert.equal(index['46xxsettings.txt'].driver, 'avaya');
  assert.equal(index['001565bbbb01.cfg'].auth, 'per-mac');
  assert.equal(index['001565bbbb01.cfg'].mac, '001565bbbb01');
  assert.equal(index['phonebook.xml'].driver, 'yealink');
  for (const n of Object.keys(index)) assert.ok(fs.existsSync(path.join(out, 'phones', n)), n + ' exists');

  fs.rmSync(out, { recursive: true, force: true });
});

test('every driver tells an engineer what to type at the handset', () => {
  for (const d of phones.DRIVERS) {
    const notes = d.setupNotes({ ext: '1234', mac: 'aabbccddeeff', url: 'https://pbx.pmcne.ph/prov/',
      fqdn: 'pbx.pmcne.ph', sipPort: 5061, provPassword: 'PROV', sipPassword: 'SIP' });
    assert.ok(Array.isArray(notes) && notes.length, d.id + ' returns setup notes');
    assert.ok(notes.every(n => typeof n === 'string' && n.length), d.id + ' notes are strings');
  }
});

// Dada, 15 Oct 2026, for 6666 PMO Support: "pls add this as the wallpaper". One handset shows its own picture;
// a picture that is missing or not a JPEG is left out rather than half-served.
test('Avaya background: the named handset fetches and shows its picture; a bad or missing picture is left out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcpbx-img-'));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
  fs.writeFileSync(path.join(dir, 'ward.jpg'), jpeg);
  fs.writeFileSync(path.join(dir, 'fake.jpg'), Buffer.from('not a jpeg'));
  const secrets = { sip: {}, prov: {} };
  const run = map => {
    const c = Object.assign({}, cfg, { phoneImagesDir: dir, avayaBackgrounds: map });
    const d = mixed(); G.ensureSecrets(d, secrets);
    return G.phoneFiles(c, d, secrets);
  };
  let files = run({ ccddee001122: 'ward.jpg' });
  const settings = files.find(f => f.name === '46xxsettings.txt').body;
  assert.match(settings, /^SET BACKGROUND_IMAGE "ward\.jpg"$/m);
  assert.match(settings, /^SET BACKGROUND_IMAGE_DISPLAY ward\.jpg$/m);
  const pic = files.find(f => f.name === 'ward.jpg');
  assert.ok(pic, 'the picture is served'); assert.equal(pic.auth, 'lan'); assert.equal(pic.type, 'image/jpeg');
  assert.ok(Buffer.compare(pic.body, jpeg) === 0, 'byte for byte');
  // controls: a missing file and a file that is not a JPEG give no picture and no setting
  for (const name of ['absent.jpg', 'fake.jpg']) {
    files = run({ ccddee001122: name });
    assert.ok(!files.some(f => f.name === name), name + ' must not be served');
    assert.doesNotMatch(files.find(f => f.name === '46xxsettings.txt').body, /BACKGROUND_IMAGE/, name + ' must not be named');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
