#!/usr/bin/env node
'use strict';
/*
 * CI: the browser phone against the REAL engine, through the REAL /ws gate. No browser - sip.js is driven with a
 * WebRTC-shaped SDP, which is enough for Asterisk to prove everything except the audio itself:
 *
 *   sign in as a phone user -> /api/softphone -> WebSocket through the gate -> REGISTER with digest -> contact in
 *   the engine -> INVITE 9197 -> 200 OK whose SDP carries a DTLS fingerprint and ICE -> BYE -> no channels left.
 *
 * Controls that must fail: the WebSocket without a session cookie; a REGISTER with the wrong password.
 * Run on the CI engine after the admin-screen step: node app/test/ws-call.js [https://127.0.0.1:8443]
 * Exits 0 only if every check holds.
 */
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const SIP = require('../public/sip');
const { connect } = require('./wsclient');

const BASE = process.argv[2] || 'https://127.0.0.1:8443';
const ADMIN = { name: process.env.CI_ADMIN || 'ci', password: process.env.CI_ADMIN_PASSWORD || 'CiAdminPassw0rd!' };
const PHONE_USER = { name: 'ci.phone', password: 'CiPhonePassw0rd!' };
const fail = m => { console.error('FAILED: ' + m); process.exit(1); };
const ok = m => console.log('ok   ' + m);
const ast = cmd => execFileSync('/usr/sbin/asterisk', ['-rx', cmd], { encoding: 'utf8' });

function api(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { 'X-PMC-PBX': '1' };
    if (cookie) headers.Cookie = cookie;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = https.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers, rejectUnauthorized: false }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ } const sc = res.headers['set-cookie']; resolve({ status: res.statusCode, json, text, cookie: sc ? sc[0].split(';')[0] : null }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const until = (fn, ms, what) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (fn()) { clearInterval(iv); resolve(); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timed out waiting for ' + what)); } }, 50);
});

// An SDP offer shaped like a browser's: DTLS-SRTP over ICE, rtcp-mux, the codecs the endpoint allows
function webrtcOffer() {
  const fp = crypto.randomBytes(32).toString('hex').toUpperCase().match(/../g).join(':');
  return ['v=0', 'o=- ' + Date.now() + ' 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
    'm=audio 9 UDP/TLS/RTP/SAVPF 9 0 8 101', 'c=IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 0.0.0.0',
    'a=candidate:1 1 udp 2122260223 127.0.0.1 40000 typ host generation 0',
    'a=ice-ufrag:' + crypto.randomBytes(4).toString('hex'), 'a=ice-pwd:' + crypto.randomBytes(12).toString('hex'),
    'a=fingerprint:sha-256 ' + fp, 'a=setup:actpass', 'a=mid:0', 'a=sendrecv', 'a=rtcp-mux',
    'a=rtpmap:9 G722/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-16', ''].join('\r\n');
}
const media = seen => ({ async create() { return {
  async offer() { return webrtcOffer(); }, async setAnswer(sdp) { seen.answer = sdp; }, async answerOffer() { return webrtcOffer(); },
  setDirection() {}, mute() {}, dtmf() {}, close() {}
}; } });

(async () => {
  // ---------------------------------------------------------------- set up through the admin API
  const a = await api('POST', '/api/login', ADMIN);
  if (a.status !== 200) fail('admin sign-in: ' + a.status + ' ' + a.text);
  let r = await api('POST', '/api/extensions', { name: 'CI Browser Phone', dept: 'ICT', model: 'webphone' }, a.cookie);
  if (r.status !== 200) fail('add webphone extension: ' + r.status + ' ' + r.text);
  const ext = r.json.ext;
  ok('browser-phone extension ' + ext + ' added');
  r = await api('POST', '/api/apply', undefined, a.cookie);
  if (r.status !== 200 || !r.json.ok) fail('apply: ' + r.status + ' ' + r.text);
  if (r.json.verified.missingEndpoints.length) fail('engine did not load ' + r.json.verified.missingEndpoints.join(','));
  ok('applied; the engine loaded every endpoint, including ' + ext);
  const ep = ast('pjsip show endpoint ' + ext);
  if (!/webrtc\s*:\s*true/i.test(ep) && !/media_encryption\s*:\s*dtls/i.test(ep)) fail('endpoint ' + ext + ' is not a WebRTC endpoint in the engine');
  if (!/transport-ws/.test(ast('pjsip show transports'))) fail('transport-ws is not loaded');
  ok('engine holds ' + ext + ' as a WebRTC endpoint, and transport-ws');
  r = await api('POST', '/api/users', { name: PHONE_USER.name, role: 'phone', password: PHONE_USER.password, ext }, a.cookie);
  if (r.status !== 200) fail('add phone user: ' + r.status + ' ' + r.text);
  const p = await api('POST', '/api/login', PHONE_USER);
  if (p.status !== 200) fail('phone user sign-in: ' + p.status);
  r = await api('GET', '/api/softphone', undefined, p.cookie);
  if (r.status !== 200) fail('/api/softphone: ' + r.status + ' ' + r.text);
  const creds = r.json;
  ok('phone user signed in and got extension ' + creds.ext + '\'s credentials');
  const wsUrl = BASE.replace(/^https/, 'wss') + creds.wsPath;

  // ---------------------------------------------------------------- CONTROL: no session, no WebSocket
  const bare = connect(wsUrl, 'sip', { origin: BASE });
  await until(() => bare.readyState === 3, 5000, 'the refused upgrade');
  if (bare.status !== 401) fail('CONTROL: a WebSocket without a session got ' + bare.status + ', expected 401 - the gate is open');
  ok('control: WebSocket without a session refused (401)');

  // ---------------------------------------------------------------- register, through the gate, on the real engine
  const seen = {};
  const ua = new SIP.UA({ ext: creds.ext, password: creds.password, name: creds.name, domain: creds.domain, wsUrl,
    connect: (u, proto) => connect(u, proto, { cookie: p.cookie, origin: BASE }), media: media(seen), log: s => process.env.SIP_DEBUG && console.log('  ' + s) });
  ua.start();
  await until(() => ua.state === 'registered' || ua.state === 'denied', 15000, 'registration').catch(e => fail(e.message + ' (state ' + ua.state + ')'));
  if (ua.state !== 'registered') fail('registration: ' + ua.state);
  ok('registered over the WebSocket with digest auth');
  const contacts = ast('pjsip show contacts');
  if (!new RegExp(creds.ext + '/sip:').test(contacts)) fail('the engine shows no contact for ' + creds.ext + ':\n' + contacts);
  ok('the engine holds a contact for ' + creds.ext);

  // ---------------------------------------------------------------- a call to 9197 (Answer, Playback)
  const call = await ua.call('9197');
  await until(() => call.state === 'active' || call.state === 'ended', 15000, 'the call to 9197').catch(e => fail(e.message));
  if (call.state !== 'active') fail('call to 9197 ended: ' + call.reason);
  const sdp = seen.answer || '';
  for (const [re, what] of [[/a=fingerprint:sha-256 /, 'a DTLS fingerprint'], [/a=ice-ufrag:/, 'ICE credentials'], [/UDP\/TLS\/RTP\/SAVPF/, 'the WebRTC media profile'], [/a=rtcp-mux/, 'rtcp-mux']]) {
    if (!re.test(sdp)) fail('the engine\'s answer has no ' + what + ':\n' + sdp);
  }
  ok('9197 answered; the engine\'s SDP carries a DTLS fingerprint, ICE, SAVPF and rtcp-mux');
  call.hangup();
  await new Promise(res => setTimeout(res, 1500));
  const ch = ast('core show channels count');
  if (!/^0 active call/m.test(ch)) fail('channels left after hang-up:\n' + ch);
  ok('hung up; no active calls left in the engine');
  await ua.stop();

  // ---------------------------------------------------------------- CONTROL: the wrong password must not register
  const bad = new SIP.UA({ ext: creds.ext, password: creds.password + 'x', domain: creds.domain, wsUrl,
    connect: (u, proto) => connect(u, proto, { cookie: p.cookie, origin: BASE }), media: media({}) });
  bad.start();
  // the engine answers a bad digest with 401 (denied here) or 403 (failed); either is a refusal, registered is not
  await until(() => ['denied', 'failed', 'registered'].includes(bad.state), 15000, 'the wrong-password registration').catch(e => fail(e.message));
  if (bad.state === 'registered') fail('CONTROL: a wrong password REGISTERED - the engine is not checking passwords');
  await bad.stop();
  ok('control: the wrong password was refused');

  console.log('VERDICT: PASS - the browser phone registers and calls through the gate on the real engine; both controls failed as they must');
  process.exit(0);
})().catch(e => fail(e.stack || e.message));
