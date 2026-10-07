#!/usr/bin/env node
'use strict';
/*
 * pmc-pbx generator.
 * Reads   <conf>/config.json, <conf>/directory.json, <conf>/secrets/secrets.json
 * Writes  <out>/asterisk/pjsip_pmc.conf, <out>/asterisk/extensions_pmc.conf,
 *         <out>/phones/<mac>.cfg (one per phone), <out>/phones/phonebook.xml, <out>/manifest.json
 * Creates any missing secret (SIP password per extension, provisioning password per MAC) and writes
 * secrets.json back with mode 0600. Secrets never go anywhere else.
 *
 * Node 22, built-ins only. Usage:
 *   node gen.js [--conf /etc/pmc-pbx] [--out /var/lib/pmc-pbx/out] [--check]
 * --check validates the directory and prints counts without writing anything.
 *
 * Yealink parameter names follow Yealink's auto-provisioning parameter reference. They are verified on the
 * first phone (phase 3 of docs/pbx-design-20261007.md), not assumed correct before that.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = parseArgs(process.argv.slice(2));
const CONF = args.conf || process.env.PMC_PBX_CONF || '/etc/pmc-pbx';
const OUT = args.out || process.env.PMC_PBX_OUT || '/var/lib/pmc-pbx/out';
const CHECK_ONLY = !!args.check;

const config = readJson(path.join(CONF, 'config.json'));
const directory = readJson(path.join(CONF, 'directory.json'));
const secretsFile = path.join(CONF, 'secrets', 'secrets.json');
const secrets = fs.existsSync(secretsFile) ? readJson(secretsFile) : { sip: {}, prov: {} };
secrets.sip = secrets.sip || {};
secrets.prov = secrets.prov || {};

const problems = validate(directory, config);
if (problems.length) {
  console.error('STOP: ' + problems.length + ' problem(s) in directory.json:');
  problems.forEach(p => console.error('  - ' + p));
  process.exit(1);
}

let newSecrets = 0;
for (const e of directory.extensions) {
  if (!secrets.sip[e.ext]) { secrets.sip[e.ext] = randomSecret(24); newSecrets++; }
  if (e.mac && !secrets.prov[e.mac]) { secrets.prov[e.mac] = randomSecret(20); newSecrets++; }
}

const phones = directory.extensions.filter(e => e.mac);
console.log('directory: ' + directory.extensions.length + ' extensions, ' + phones.length + ' phones, ' +
  newSecrets + ' new secret(s)' + (CHECK_ONLY ? ' (check only, nothing written)' : ''));
if (CHECK_ONLY) process.exit(0);

ensureDir(path.dirname(secretsFile));
writeFileAtomic(secretsFile, JSON.stringify(secrets, null, 2) + '\n', 0o600);

ensureDir(path.join(OUT, 'asterisk'));
ensureDir(path.join(OUT, 'phones'));

writeFileAtomic(path.join(OUT, 'asterisk', 'pjsip_pmc.conf'), renderPjsip(directory, config, secrets));
writeFileAtomic(path.join(OUT, 'asterisk', 'extensions_pmc.conf'), renderDialplan(directory, config));
for (const e of phones) {
  writeFileAtomic(path.join(OUT, 'phones', e.mac + '.cfg'), renderYealink(e, directory, config, secrets));
}
writeFileAtomic(path.join(OUT, 'phones', 'phonebook.xml'), renderPhonebook(directory));

const manifest = {
  generatedAt: new Date().toISOString(),
  extensions: directory.extensions.length,
  phones: phones.length,
  directoryVersion: sha256(JSON.stringify(directory)).slice(0, 16),
  fqdn: config.fqdn
};
writeFileAtomic(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('written to ' + OUT + ' (directory version ' + manifest.directoryVersion + ')');

// ------------------------------------------------------------------ validation
function validate(dir, cfg) {
  const out = [];
  if (!cfg || !cfg.fqdn) out.push('config.json: fqdn missing');
  if (!cfg || !cfg.externalIp) out.push('config.json: externalIp missing');
  if (!Array.isArray(cfg.localNets) || !cfg.localNets.length) out.push('config.json: localNets missing');
  if (!dir || !Array.isArray(dir.extensions)) { out.push('directory.json: "extensions" array missing'); return out; }
  const seenExt = new Set(), seenMac = new Set();
  for (const e of dir.extensions) {
    const id = e.ext || '?';
    if (!/^[1-9][0-9]{3}$/.test(String(e.ext || ''))) out.push(id + ': ext must be 4 digits, not starting with 0');
    if (seenExt.has(e.ext)) out.push(id + ': duplicate ext'); seenExt.add(e.ext);
    if (!e.name || !String(e.name).trim()) out.push(id + ': name missing');
    if (e.mac !== undefined && e.mac !== null && e.mac !== '') {
      if (!/^[0-9a-f]{12}$/.test(String(e.mac))) out.push(id + ': mac must be 12 lower-case hex characters, no separators');
      if (seenMac.has(e.mac)) out.push(id + ': duplicate mac ' + e.mac); seenMac.add(e.mac);
    }
    if (Array.isArray(e.keys)) {
      e.keys.forEach((k, i) => {
        if (k.type !== 'blf' && k.type !== 'speed') out.push(id + ': key ' + (i + 1) + ' type must be blf or speed');
        if (!/^[1-9][0-9]{3}$/.test(String(k.ext || ''))) out.push(id + ': key ' + (i + 1) + ' needs a 4-digit ext');
      });
    }
  }
  for (const e of dir.extensions) {
    (e.keys || []).forEach((k, i) => { if (!seenExt.has(k.ext)) out.push(e.ext + ': key ' + (i + 1) + ' points at unknown ext ' + k.ext); });
  }
  return out;
}

// ------------------------------------------------------------------ Asterisk
function renderPjsip(dir, cfg, sec) {
  const L = [];
  L.push('; GENERATED by pmc-pbx gen.js ' + new Date().toISOString() + ' - do not edit, edit directory.json');
  L.push('');
  L.push('[transport-tls]');
  L.push('type=transport');
  L.push('protocol=tls');
  L.push('bind=0.0.0.0:' + (cfg.sipPort || 5061));
  L.push('cert_file=' + (cfg.certFile || '/etc/pmc-pbx/secrets/cert.pem'));
  L.push('priv_key_file=' + (cfg.keyFile || '/etc/pmc-pbx/secrets/key.pem'));
  L.push('method=tlsv1_2');
  L.push('external_media_address=' + cfg.externalIp);
  L.push('external_signaling_address=' + cfg.externalIp);
  cfg.localNets.forEach(n => L.push('local_net=' + n));
  L.push('allow_reload=no');
  L.push('');
  L.push('[pmc-endpoint](!)');
  L.push('type=endpoint');
  L.push('context=pmc-internal');
  L.push('disallow=all');
  (cfg.codecs || ['g722', 'alaw', 'ulaw']).forEach(c => L.push('allow=' + c));
  L.push('transport=transport-tls');
  L.push('media_encryption=sdes');
  L.push('media_encryption_optimistic=no');
  L.push('direct_media=no');
  L.push('rtp_symmetric=yes');
  L.push('force_rport=yes');
  L.push('rewrite_contact=yes');
  L.push('dtmf_mode=rfc4733');
  L.push('language=en');
  L.push('device_state_busy_at=1');
  L.push('');
  L.push('[pmc-auth](!)');
  L.push('type=auth');
  L.push('auth_type=userpass');
  L.push('');
  L.push('[pmc-aor](!)');
  L.push('type=aor');
  L.push('max_contacts=1');
  L.push('remove_existing=yes');
  L.push('qualify_frequency=60');
  L.push('');
  for (const e of dir.extensions) {
    const cid = '"' + String(e.name).replace(/"/g, '') + '" <' + e.ext + '>';
    L.push('; ' + e.ext + ' ' + e.name + (e.dept ? ' (' + e.dept + ')' : ''));
    L.push('[' + e.ext + '](pmc-endpoint)');
    L.push('auth=' + e.ext);
    L.push('aors=' + e.ext);
    L.push('callerid=' + cid);
    if (e.voicemail) L.push('mailboxes=' + e.ext + '@pmc');
    L.push('[' + e.ext + '](pmc-auth)');
    L.push('username=' + e.ext);
    L.push('password=' + sec.sip[e.ext]);
    L.push('[' + e.ext + '](pmc-aor)');
    L.push('');
  }
  return L.join('\n');
}

function renderDialplan(dir, cfg) {
  const L = [];
  L.push('; GENERATED by pmc-pbx gen.js ' + new Date().toISOString() + ' - do not edit, edit directory.json');
  L.push('');
  L.push('[pmc-internal]');
  L.push('; emergency numbers go nowhere without a trunk: say so instead of silence');
  L.push('exten => 911,1,Answer()');
  L.push(' same => n,Playback(vm-goodbye)');
  L.push(' same => n,Hangup()');
  L.push('exten => 117,1,Goto(911,1)');
  L.push('; test numbers');
  L.push('exten => 9196,1,Answer()');
  L.push(' same => n,Echo()');
  L.push(' same => n,Hangup()');
  L.push('exten => 9197,1,Answer()');
  L.push(' same => n,Playback(demo-congrats)');
  L.push(' same => n,Hangup()');
  L.push('; voicemail access');
  L.push('exten => *97,1,VoiceMailMain(${CALLERID(num)}@pmc)');
  L.push(' same => n,Hangup()');
  L.push('; hints for BLF');
  for (const e of dir.extensions) L.push('exten => ' + e.ext + ',hint,PJSIP/' + e.ext);
  L.push('; extension to extension');
  L.push('exten => _[1-8]XXX,1,NoOp(PMC call ${CALLERID(num)} -> ${EXTEN})');
  L.push(' same => n,Dial(PJSIP/${EXTEN},' + (cfg.ringSeconds || 25) + ')');
  L.push(' same => n,GotoIf($["${DIALSTATUS}" = "BUSY"]?busy)');
  L.push(' same => n,VoiceMail(${EXTEN}@pmc,u)');
  L.push(' same => n,Hangup()');
  L.push(' same => n(busy),VoiceMail(${EXTEN}@pmc,b)');
  L.push(' same => n,Hangup()');
  L.push('');
  return L.join('\n');
}

// ------------------------------------------------------------------ Yealink
function renderYealink(e, dir, cfg, sec) {
  const provUrl = cfg.provUrl || ('https://' + cfg.fqdn + '/prov/');
  const L = [];
  L.push('#!version:1.0.0.1');
  L.push('## GENERATED by pmc-pbx for ' + e.ext + ' ' + e.name + ' (' + e.mac + ') ' + new Date().toISOString());
  L.push('');
  L.push('static.auto_provision.server.url = ' + provUrl);
  L.push('static.auto_provision.server.username = ' + e.mac);
  L.push('static.auto_provision.server.password = ' + sec.prov[e.mac]);
  L.push('static.auto_provision.power_on = 1');
  L.push('static.auto_provision.repeat.enable = 1');
  L.push('static.auto_provision.repeat.minutes = 1440');
  L.push('static.security.trust_certificates = 1');
  L.push('');
  L.push('account.1.enable = 1');
  L.push('account.1.label = ' + e.ext);
  L.push('account.1.display_name = ' + e.name);
  L.push('account.1.auth_name = ' + e.ext);
  L.push('account.1.user_name = ' + e.ext);
  L.push('account.1.password = ' + sec.sip[e.ext]);
  L.push('account.1.sip_server.1.address = ' + cfg.fqdn);
  L.push('account.1.sip_server.1.port = ' + (cfg.sipPort || 5061));
  L.push('account.1.sip_server.1.transport_type = 2');
  L.push('account.1.sip_server.1.expires = 300');
  L.push('account.1.srtp_encryption = 2');
  L.push('account.1.outbound_proxy_enable = 0');
  L.push('account.1.dtmf.type = 1');
  L.push('account.1.codec.1.enable = 1');
  L.push('account.1.codec.1.payload_type = G722');
  L.push('account.1.codec.1.priority = 1');
  L.push('account.1.codec.2.enable = 1');
  L.push('account.1.codec.2.payload_type = PCMA');
  L.push('account.1.codec.2.priority = 2');
  L.push('account.1.codec.3.enable = 1');
  L.push('account.1.codec.3.payload_type = PCMU');
  L.push('account.1.codec.3.priority = 3');
  L.push('account.1.subscribe_mwi = ' + (e.voicemail ? '1' : '0'));
  L.push('voice_mail.number.1 = *97');
  L.push('');
  L.push('features.remote_phonebook.enable = 1');
  L.push('remote_phonebook.data.1.url = ' + provUrl + 'phonebook.xml');
  L.push('remote_phonebook.data.1.name = PMC');
  L.push('');
  L.push('local_time.time_zone = +8');
  L.push('local_time.time_zone_name = Philippines(Manila)');
  L.push('local_time.ntp_server1 = ' + (cfg.ntpServer || 'pool.ntp.org'));
  L.push('lang.gui = English');
  L.push('');
  (e.keys || []).forEach((k, i) => {
    const n = i + 1;
    const target = dir.extensions.find(x => x.ext === k.ext) || {};
    L.push('linekey.' + n + '.type = ' + (k.type === 'blf' ? '16' : '13'));
    L.push('linekey.' + n + '.line = 1');
    L.push('linekey.' + n + '.value = ' + k.ext);
    L.push('linekey.' + n + '.label = ' + (k.label || target.name || k.ext));
  });
  L.push('');
  return L.join('\n');
}

function renderPhonebook(dir) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = dir.extensions.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<YealinkIPPhoneDirectory>'];
  for (const e of rows) {
    L.push('  <DirectoryEntry><Name>' + esc(e.name) + (e.dept ? ' - ' + esc(e.dept) : '') + '</Name><Telephone>' + esc(e.ext) + '</Telephone></DirectoryEntry>');
  }
  L.push('</YealinkIPPhoneDirectory>', '');
  return L.join('\n');
}

// ------------------------------------------------------------------ helpers
function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      if (i + 1 < a.length && !a[i + 1].startsWith('--')) { o[k] = a[i + 1]; i++; } else { o[k] = true; }
    }
  }
  return o;
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (err) { console.error('cannot read ' + p + ': ' + err.message); process.exit(2); }
}
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function writeFileAtomic(p, content, mode) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content, { mode: mode || 0o644 });
  fs.renameSync(tmp, p);
}
function randomSecret(n) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
