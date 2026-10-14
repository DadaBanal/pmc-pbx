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
 * And the gate cannot be walked round (review 14 Oct 2026): the browser phone's own password, sent straight to the
 * engine's SIP-over-TLS port, is refused. Its control: a desk phone's password on the same port is accepted.
 * Run on the CI engine after the admin-screen step: node app/test/ws-call.js [https://127.0.0.1:8443]
 * Exits 0 only if every check holds.
 */
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
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

// This machine's own non-loopback address. The direct-to-5061 checks must come from here: the webphone ACL PERMITS
// 127.0.0.1, because that is where the app's /ws gate reaches the engine from, so a check from loopback proves
// nothing (CI run 38478413957, 14 Oct 2026, registered from 127.0.0.1 and failed this run for exactly that reason).
function ownAddress() {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
}

// One REGISTER straight to the engine's TLS port, from addr, digest included; resolves to the final status (or 'timeout').
function tlsRegister(ext, password, domain, addr) {
  return new Promise(resolve => {
    const callId = crypto.randomBytes(8).toString('hex'), tag = crypto.randomBytes(4).toString('hex');
    let cseq = 0, buf = '', done = false;
    const finish = v => { if (done) return; done = true; clearTimeout(timer); try { sock.end(); } catch (e) { /* closed */ } resolve(v); };
    const timer = setTimeout(() => finish('timeout'), 10000);
    const sock = tls.connect({ host: addr, port: 5061, localAddress: addr, rejectUnauthorized: false }, () => send(null));
    sock.on('error', e => finish('error ' + e.message));
    function send(auth) {
      cseq++;
      const port = sock.localPort;
      const h = [['Via', 'SIP/2.0/TLS ' + addr + ':' + port + ';branch=z9hG4bK' + crypto.randomBytes(6).toString('hex') + ';rport'], ['Max-Forwards', '70'],
        ['From', '<sip:' + ext + '@' + domain + '>;tag=' + tag], ['To', '<sip:' + ext + '@' + domain + '>'], ['Call-ID', callId], ['CSeq', cseq + ' REGISTER'],
        ['Contact', '<sip:' + ext + '@' + addr + ':' + port + ';transport=tls>'], ['Expires', '60']];
      if (auth) h.push(['Authorization', auth]);
      sock.write(SIP.build('REGISTER sip:' + domain + ' SIP/2.0', h, ''));
    }
    sock.on('data', d => {
      buf += d.toString('utf8');
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end);
        const len = Number((/content-length:\s*(\d+)/i.exec(head) || [0, 0])[1]);
        if (buf.length < end + 4 + len) return;
        const msg = SIP.parse(buf.slice(0, end + 4 + len));
        buf = buf.slice(end + 4 + len);
        if (!msg.status || msg.status < 200) continue;
        if ((msg.status === 401 || msg.status === 407) && cseq === 1) {
          const ch = SIP.parseChallenge((msg.headers['www-authenticate'] || msg.headers['proxy-authenticate'] || [''])[0]);
          send(SIP.digestAuthorization(ch, { username: ext, password, method: 'REGISTER', uri: 'sip:' + domain, cnonce: crypto.randomBytes(8).toString('hex'), nc: 1 }).header);
          continue;
        }
        return finish(msg.status);
      }
    });
  });
}

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
// one browser-shaped session that keeps its ICE and DTLS identity across re-INVITEs (hold), answers as DTLS active,
// and puts the hold direction in its SDP, as a browser does
const sessionMedia = () => ({ async create() {
  const fp = crypto.randomBytes(32).toString('hex').toUpperCase().match(/../g).join(':');
  const ufrag = crypto.randomBytes(4).toString('hex'), pwd = crypto.randomBytes(12).toString('hex');
  let dir = 'sendrecv', ver = 2;
  const sdp = setup => ['v=0', 'o=- 4242 ' + (ver++) + ' IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
    'm=audio 9 UDP/TLS/RTP/SAVPF 9 0 8 101', 'c=IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 0.0.0.0',
    'a=candidate:1 1 udp 2122260223 127.0.0.1 40000 typ host generation 0', 'a=ice-ufrag:' + ufrag, 'a=ice-pwd:' + pwd,
    'a=fingerprint:sha-256 ' + fp, 'a=setup:' + setup, 'a=mid:0', 'a=' + dir, 'a=rtcp-mux',
    'a=rtpmap:9 G722/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-16', ''].join('\r\n');
  return { async offer() { return sdp('actpass'); }, async setAnswer() {}, async answerOffer() { return sdp('active'); },
    setDirection(d) { dir = d; }, mute() {}, dtmf() {}, close() {} };
} });
// which bridge each PJSIP channel of an extension sits in, from the engine itself
function bridgesOf(ext) {
  const out = new Set();
  for (const line of ast('core show channels concise').split('\n')) {
    const f = line.split('!');
    if (f[0] && f[0].startsWith('PJSIP/' + ext + '-') && f[12]) out.add(f[12]);
  }
  return out;
}
const together = (x, y) => { const bx = bridgesOf(x); return Array.from(bridgesOf(y)).some(b => bx.has(b)); };
const channelsOf = ext => ast('core show channels concise').split('\n').filter(l => l.startsWith('PJSIP/' + ext + '-')).length;

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
  for (const [re, what] of [[/a=fingerprint:sha-256 /i, 'a DTLS fingerprint'], [/a=ice-ufrag:/, 'ICE credentials'], [/UDP\/TLS\/RTP\/SAVPF/, 'the WebRTC media profile'], [/a=rtcp-mux/, 'rtcp-mux']]) {
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

  // ---------------------------------------------------------------- the gate cannot be walked round
  const own = ownAddress();
  if (!own) fail('no non-loopback address on this machine to test 5061 from');
  ok('direct 5061 checks come from ' + own + ', not loopback');
  const direct = await tlsRegister(creds.ext, creds.password, creds.domain, own);
  if (direct === 200) fail('the browser phone\'s password REGISTERED straight on 5061 - the engine accepts it outside the gate');
  ok('the browser phone\'s own password, sent straight to 5061, was refused (' + direct + ')');
  const secrets = JSON.parse(fs.readFileSync(process.env.PMC_SECRETS || '/etc/pmc-pbx/secrets/secrets.json', 'utf8'));
  const desk = Object.keys(secrets.sip).find(x => x !== creds.ext && /^1\d{3}$/.test(x));
  if (!desk) fail('no desk-phone extension to use as the control');
  const deskStatus = await tlsRegister(desk, secrets.sip[desk], creds.domain, own);
  if (deskStatus !== 200) fail('CONTROL: desk phone ' + desk + ' could not register on 5061 (' + deskStatus + '), so the refusal above proves nothing');
  ok('control: desk phone ' + desk + ' registered on 5061 with its own password (200)');

  // ---------------------------------------------------------------- modern functions on the real engine (14 Oct 2026)
  // Three browser phones through the gate: A (ci.phone's own), B (twice: two devices), C. Every leg here carries no
  // RTP, so the engine's rtp_timeout (30 s) bounds the whole section; it runs in well under that.
  const addPhone = async name => {
    const x = await api('POST', '/api/extensions', { name, dept: 'ICT', model: 'webphone' }, a.cookie);
    if (x.status !== 200) fail('add ' + name + ': ' + x.status + ' ' + x.text);
    return x.json.ext;
  };
  const extB = await addPhone('CI Phone B'), extC = await addPhone('CI Phone C');
  r = await api('POST', '/api/apply', undefined, a.cookie);
  if (r.status !== 200 || !r.json.ok) fail('apply B and C: ' + r.status + ' ' + r.text);
  const sec2 = JSON.parse(fs.readFileSync(process.env.PMC_SECRETS || '/etc/pmc-pbx/secrets/secrets.json', 'utf8'));
  const phone = (ext, password) => new SIP.UA({ ext, password, name: 'CI ' + ext, domain: creds.domain, wsUrl,
    connect: (u, proto) => connect(u, proto, { cookie: p.cookie, origin: BASE }), media: sessionMedia(), log: s => process.env.SIP_DEBUG && console.log('  [' + ext + '] ' + s) });
  const A = phone(creds.ext, creds.password), B = phone(extB, sec2.sip[extB]), B2 = phone(extB, sec2.sip[extB]), C = phone(extC, sec2.sip[extC]);
  const rang = { B: [], B2: [], C: [], A: [] };
  // B, C and A answer whatever rings, unless it is call waiting (the test answers those itself)
  for (const [k, u] of [['A', A], ['B', B], ['B2', B2], ['C', C]]) u.on('incoming', c => { rang[k].push(c); if (!c.waiting && k !== 'B2') setTimeout(() => c.answer(), 200); });
  for (const u of [A, B, B2, C]) u.start();
  await until(() => [A, B, B2, C].every(u => u.state === 'registered'), 15000, 'four registrations').catch(e => fail(e.message));
  ok('four browser phones registered: ' + creds.ext + ', ' + extB + ' on two devices, ' + extC);

  // every device rings; the one that is not answered is told "answered elsewhere", not "missed"
  const ab = await A.call(extB);
  await until(() => rang.B.length && rang.B2.length, 8000, 'both of ' + extB + '\'s devices to ring').catch(() => fail('ring all: ' + extB + ' rang on ' + (rang.B.length + rang.B2.length) + ' of 2 devices - Dial is reaching only one'));
  await until(() => ab.state === 'active', 8000, 'A to B answered').catch(e => fail(e.message));
  await until(() => rang.B2[0].state === 'ended', 5000, 'the second device to stop ringing').catch(e => fail(e.message));
  if (rang.B2[0].reason !== 'answered elsewhere') fail('the second device ended with "' + rang.B2[0].reason + '", expected "answered elsewhere"');
  ok('both of ' + extB + '\'s devices rang; one answered, the other was told "answered elsewhere"');
  await B2.stop();

  // call waiting: C calls B while B talks to A; B holds A and answers C
  const ba = rang.B[0];
  const cb = await C.call(extB);
  await until(() => rang.B.length === 2, 8000, 'the waiting call to reach B').catch(() => fail('call waiting: C\'s call never reached B (busy instead?) - ' + cb.state + ' ' + cb.reason));
  const waiting = rang.B[1];
  if (!waiting.waiting) fail('the second call to B was not marked as call waiting');
  await ba.hold(true);
  if (!ba.held) fail('B could not put A on hold on the real engine');
  await waiting.answer();
  await until(() => cb.state === 'active', 8000, 'C answered by B').catch(e => fail(e.message));
  ok('call waiting: C rang through to B mid-call; B held A (re-INVITE accepted) and answered C');

  // attended transfer: B connects A (held) to C and drops off
  const t1 = await ba.transfer(null, waiting);
  if (!t1.ok) fail('attended transfer refused by the engine: ' + t1.why);
  await until(() => channelsOf(extB) === 0, 8000, 'B to leave both calls').catch(() => fail('after the attended transfer B still has ' + channelsOf(extB) + ' channel(s)'));
  await until(() => together(creds.ext, extC), 5000, 'A and C bridged').catch(() => fail('after the attended transfer A and C are not in one bridge'));
  if (ab.state !== 'active' || cb.state !== 'active') fail('a caller was dropped by the attended transfer (A ' + ab.state + ', C ' + cb.state + ')');
  ok('attended transfer: A and C are bridged together, B has no channels left');

  // blind transfer: A sends C straight to B
  const t2 = await ab.transfer(extB);
  if (!t2.ok) fail('blind transfer refused by the engine: ' + t2.why);
  await until(() => channelsOf(creds.ext) === 0 && together(extC, extB), 8000, 'C bridged to B, A gone').catch(() => fail('after the blind transfer: A channels ' + channelsOf(creds.ext) + ', C with B ' + together(extC, extB)));
  ok('blind transfer: C now talks to B; A dropped off');

  // three-way call: B (talking to C) holds C, calls A, merges all three into room *88<B>
  const bc = rang.B[rang.B.length - 1];
  await bc.hold(true);
  const ba2 = await B.call(creds.ext);
  await until(() => ba2.state === 'active', 8000, 'B to A answered').catch(e => fail(e.message));
  const roomNo = '*88' + extB;
  const m1 = await ba2.transfer(roomNo), m2 = await bc.transfer(roomNo);
  if (!m1.ok || !m2.ok) fail('moving the calls into the conference was refused: ' + (m1.why || m2.why));
  const mine = await B.call(roomNo);
  await until(() => mine.state === 'active', 8000, 'B to join its room').catch(e => fail('the owner could not join ' + roomNo + ': ' + mine.reason));
  const members = () => (ast('confbridge list pmc' + extB).match(new RegExp('PJSIP/', 'g')) || []).length;
  await until(() => members() === 3, 6000, 'three in the room').catch(() => fail('conference pmc' + extB + ' holds ' + members() + ' members, expected 3:\n' + ast('confbridge list pmc' + extB)));
  ok('three-way call: B, A and C are all in conference pmc' + extB);
  // CONTROL: someone who was not moved in by the owner is refused at the door
  const intruder = await A.call(roomNo);
  await until(() => intruder.state === 'ended' || intruder.state === 'active', 8000, 'the intruder\'s call').catch(e => fail(e.message));
  if (intruder.state === 'active') fail('CONTROL: ' + creds.ext + ' dialled ' + roomNo + ' directly and was let in - the room is open to anyone');
  if (members() !== 3) fail('CONTROL: the room now holds ' + members() + ' members');
  ok('control: dialling ' + roomNo + ' directly from ' + creds.ext + ' was refused (' + intruder.reason + '); the room still holds 3');
  // the owner leaves: the room closes for everyone, as a three-way call does
  mine.hangup();
  await until(() => !/PJSIP\//.test(ast('confbridge list pmc' + extB)) && channelsOf(creds.ext) + channelsOf(extC) === 0, 8000, 'the room to close').catch(() => fail('the owner left but the room still holds:\n' + ast('confbridge list pmc' + extB)));
  ok('the owner hung up and the conference closed for everyone');
  for (const u of [A, B, C]) await u.stop();
  await new Promise(res => setTimeout(res, 1000));
  if (!/^0 active call/m.test(ast('core show channels count'))) fail('channels left after the modern-function checks:\n' + ast('core show channels count'));
  ok('no active calls left');

  console.log('VERDICT: PASS - the browser phone registers and calls through the gate on the real engine, and only through the gate; ring-all, call waiting, both transfers and the three-way call work on the real engine; every control behaved');
  process.exit(0);
})().catch(e => fail(e.stack || e.message));
