'use strict';
// The browser phone's SIP stack (app/public/sip.js), driven by a scripted SIP server in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const SIP = require('../public/sip');

test('MD5 matches the RFC 1321 test suite, and Node crypto on arbitrary text', () => {
  const suite = {
    '': 'd41d8cd98f00b204e9800998ecf8427e',
    a: '0cc175b9c0f1b6a831c399e269772661',
    abc: '900150983cd24fb0d6963f7d28e17f72',
    'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
    abcdefghijklmnopqrstuvwxyz: 'c3fcd3d76192e4007dfb496cca67e13b',
    ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789: 'd174ab98d277d9f5a5611c2c9f419d9f',
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890': '57edf4a22be3c955ac49da2e2107b67a'
  };
  for (const [input, want] of Object.entries(suite)) assert.equal(SIP.md5(input), want, 'RFC 1321: ' + JSON.stringify(input));
  // lengths around the 55/56/64-byte padding boundaries, and non-ASCII
  for (const s of ['x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'Nino Dela Pena nino', 'caf\u00e9 \u00f1']) {
    assert.equal(SIP.md5(s), crypto.createHash('md5').update(s, 'utf8').digest('hex'), 'length ' + s.length);
  }
  // control: a different input must not give the same digest
  assert.notEqual(SIP.md5('abc'), SIP.md5('abd'));
});

test('digest authentication reproduces the RFC 2617 worked example exactly', () => {
  const ch = SIP.parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  assert.equal(ch.realm, 'testrealm@host.com');
  const a = SIP.digestAuthorization(ch, { username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', cnonce: '0a4f113b', nc: 1 });
  assert.equal(a.response, '6629fae49393a05397450978507c4ef1');
  assert.match(a.header, /qop=auth, nc=00000001/);
  assert.match(a.header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  // control: one wrong character in the password gives a different response
  const b = SIP.digestAuthorization(ch, { username: 'Mufasa', password: 'Circle of Life', method: 'GET', uri: '/dir/index.html', cnonce: '0a4f113b', nc: 1 });
  assert.notEqual(b.response, a.response);
  assert.throws(() => SIP.digestAuthorization({ realm: 'r', nonce: 'n', algorithm: 'SHA-256' }, { username: 'u', password: 'p', method: 'REGISTER', uri: 'sip:x' }), /SHA-256/);
});

test('messages: parse folded, compact and comma-joined headers; build with a correct Content-Length', () => {
  const raw = 'SIP/2.0 200 OK\r\nv: SIP/2.0/WS a.invalid;branch=z9hG4bK1, SIP/2.0/WS b.invalid;branch=z9hG4bK2\r\n' +
    'f: <sip:1201@pbx>;tag=abc\r\nTo: "Nurse"\r\n <sip:1202@pbx>;tag=xyz\r\ni: call-1\r\nCSeq: 7 INVITE\r\nl: 4\r\n\r\nv=0\n';
  const m = SIP.parse(raw);
  assert.equal(m.status, 200);
  assert.equal(m.headers.via.length, 2);
  assert.equal(SIP.branchOf(m.headers.via[0]), 'z9hG4bK1');
  assert.equal(SIP.tagOf(m.headers.from[0]), 'abc');
  assert.equal(SIP.tagOf(m.headers.to[0]), 'xyz');
  assert.equal(SIP.uriOf(m.headers.to[0]), 'sip:1202@pbx');
  assert.equal(m.headers['call-id'][0], 'call-1');
  const built = SIP.build('OPTIONS sip:pbx SIP/2.0', [['Call-ID', 'x']], 'caf\u00e9');
  assert.match(built, /Content-Length: 5\r\n\r\ncaf\u00e9$/, 'length counts UTF-8 bytes');
  assert.throws(() => SIP.parse('HTTP/1.1 200 OK\r\n\r\n'), /not a SIP message/);
});

// ------------------------------------------------------------------------------------------- a scripted server
// It plays Asterisk's part: challenges REGISTER and the first INVITE, answers, rings, and records what it got.
function harness(opts) {
  opts = opts || {};
  const got = [];
  const realm = 'asterisk';
  const nonce = 'n0nce' + Math.random().toString(16).slice(2);
  let ws = null;
  const reply = (req, status, reason, extra, body) => {
    const h = (req.headers.via || []).map(v => ['Via', v]);
    let to = req.headers.to[0];
    if (!SIP.tagOf(to)) to += ';tag=srv' + req.headers['call-id'][0].slice(0, 4);
    h.push(['To', to], ['From', req.headers.from[0]], ['Call-ID', req.headers['call-id'][0]], ['CSeq', req.headers.cseq[0]]);
    for (const x of extra || []) h.push(x);
    if (body) h.push(['Content-Type', 'application/sdp']);
    setImmediate(() => ws.onmessage({ data: SIP.build('SIP/2.0 ' + status + ' ' + reason, h, body) }));
  };
  const authorised = (req, method) => {
    const v = (req.headers.authorization || [])[0];
    if (!v) return false;
    const p = SIP.parseChallenge(v);
    const ha1 = SIP.md5(p.username + ':' + realm + ':' + opts.password);
    const ha2 = SIP.md5(method + ':' + p.uri);
    return p.response === SIP.md5(ha1 + ':' + nonce + ':' + p.nc + ':' + p.cnonce + ':auth:' + ha2);
  };
  const challenge = ['WWW-Authenticate', 'Digest realm="' + realm + '", nonce="' + nonce + '", qop="auth", algorithm=MD5'];
  const server = {
    got,
    connect() {
      server.connections = (server.connections || 0) + 1;
      ws = {
        sent: [], readyState: 1,
        send(text) {
          const m = SIP.parse(text); got.push(m);
          if (m.method === 'REGISTER') server.regs = (server.regs || 0) + 1;
          if (m.method === 'REGISTER' && opts.regFail && server.regs <= opts.regFail) return reply(m, 503, 'Service Unavailable');
          if (m.method === 'REGISTER' && server.silent) return undefined; // a dead engine: the request is never answered
          if (m.method === 'REGISTER') return authorised(m, 'REGISTER') ? reply(m, 200, 'OK', [['Contact', m.headers.contact[0] + ';expires=300']]) : reply(m, 401, 'Unauthorized', [challenge]);
          if (m.method === 'INVITE' && !SIP.tagOf(m.headers.to[0])) {
            if (!authorised(m, 'INVITE')) return reply(m, 401, 'Unauthorized', [challenge]);
            reply(m, 100, 'Trying');
            reply(m, 180, 'Ringing');
            if (opts.busy) return reply(m, 486, 'Busy Here');
            return reply(m, 200, 'OK', [['Contact', '<sip:srv@127.0.0.1:8088;transport=ws>']], 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=sendrecv\r\n');
          }
          if (m.method === 'INVITE') return reply(m, 200, 'OK', [], 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=recvonly\r\n');
          if (m.method === 'BYE') return reply(m, 200, 'OK');
          if (m.method === 'REFER') {
            reply(m, 202, 'Accepted');
            const frag = opts.referFrag || 'SIP/2.0 200 OK';
            setImmediate(() => {
              server.push(inDialogFromEngine('NOTIFY', m, 'Event: refer\r\nSubscription-State: terminated;reason=noresource\r\nContent-Type: message/sipfrag;version=2.0', frag + '\r\n'));
              if (/^SIP\/2\.0 2/.test(frag) && !opts.referNoBye) setImmediate(() => server.push(inDialogFromEngine('BYE', m, '', '')));
            });
            return undefined;
          }
          return undefined; // ACK, responses
        },
        close() { if (this.onclose) this.onclose(); }
      };
      setImmediate(() => ws.onopen());
      return ws;
    },
    push(text) { ws.onmessage({ data: text }); },
    last(method) { return got.filter(m => m.method === method || (m.status && method === m.status)).pop(); }
  };
  return server;
}
// a request the engine sends inside the dialog of request m (which this phone sent): From and To swap sides
let engineCseq = 100;
function inDialogFromEngine(method, m, extra, body) {
  return method + ' sip:abc@x.invalid;transport=ws SIP/2.0\r\nVia: SIP/2.0/WS 127.0.0.1:8088;branch=z9hG4bKeng' + (engineCseq++) + '\r\n' +
    'From: ' + m.headers.to[0] + '\r\nTo: ' + m.headers.from[0] + '\r\nCall-ID: ' + m.headers['call-id'][0] + '\r\nCSeq: ' + engineCseq + ' ' + method + '\r\n' +
    (extra ? extra + '\r\n' : '') + 'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body;
}
const fakeMedia = () => {
  const log = [];
  return { log, async create() { return {
    async offer() { log.push('offer'); return 'v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=sendrecv\r\n'; },
    async setAnswer(sdp) { log.push('answer:' + /a=(sendrecv|recvonly|sendonly)/.exec(sdp)[1]); },
    async answerOffer() { log.push('answerOffer'); return 'v=0\r\no=- 9 10 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=sendrecv\r\n'; },
    setDirection(d) { log.push('dir:' + d); }, mute(on) { log.push('mute:' + on); }, dtmf(x) { log.push('dtmf:' + x); }, close() { log.push('close'); }
  }; } };
};
const until = (fn, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (fn()) { clearInterval(iv); resolve(); } else if (Date.now() - t0 > (ms || 2000)) { clearInterval(iv); reject(new Error('timed out')); } }, 5);
});

test('registers through a digest challenge, places a call through a second challenge, holds, hangs up', async () => {
  const srv = harness({ password: 'S3cret-1201' });
  const media = fakeMedia();
  const ua = new SIP.UA({ ext: '1201', password: 'S3cret-1201', name: 'Nurse 1', domain: 'pbx.pmcne.ph', wsUrl: 'wss://x/ws', connect: () => srv.connect(), media });
  const states = [];
  ua.on('state', s => states.push(s));
  ua.start();
  await until(() => ua.state === 'registered');
  const regs = srv.got.filter(m => m.method === 'REGISTER');
  assert.equal(regs.length, 2, 'one challenged REGISTER, one authorised');
  assert.ok(!regs[0].headers.authorization && regs[1].headers.authorization);
  assert.equal(regs[0].headers['call-id'][0], regs[1].headers['call-id'][0], 'the same registration Call-ID');

  const call = await ua.call('1202');
  await until(() => call.state === 'active');
  const invites = srv.got.filter(m => m.method === 'INVITE');
  assert.equal(invites.length, 2, 'challenged INVITE then authorised INVITE');
  assert.equal(SIP.parse(SIP.build('X sip:a SIP/2.0', [['CSeq', invites[1].headers.cseq[0]]])).headers.cseq[0], '2 INVITE', 'CSeq moved on after the challenge');
  const acks = srv.got.filter(m => m.method === 'ACK');
  assert.equal(acks.length, 2, 'an ACK for the 401 and one for the 200');
  assert.equal(acks[1].uri, 'sip:srv@127.0.0.1:8088;transport=ws', 'the 2xx ACK goes to the Contact');
  assert.ok(media.log.includes('answer:sendrecv'));

  await call.hold(true);
  assert.equal(call.held, true);
  assert.ok(media.log.includes('dir:sendonly'));
  call.dtmf('5'); call.mute(true);
  assert.ok(media.log.includes('dtmf:5') && media.log.includes('mute:true'));
  call.hangup();
  await until(() => srv.got.some(m => m.method === 'BYE'));
  assert.equal(call.state, 'ended');
  assert.equal(call.reason, 'hung up');
  assert.ok(media.log.includes('close'));
  await ua.stop();
});

test('a wrong password ends in "denied" after one try, not a loop', async () => {
  const srv = harness({ password: 'the-real-one' });
  const ua = new SIP.UA({ ext: '1201', password: 'not-it', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media: fakeMedia() });
  ua.start();
  await until(() => ua.state === 'denied');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(srv.got.filter(m => m.method === 'REGISTER').length, 2, 'stopped after the authorised retry failed');
});

test('a refused password is tried again later, slowly, so a phone recovers once the engine knows it', async () => {
  const srv = harness({ password: 'the-real-one' });
  const ua = new SIP.UA({ ext: '1201', password: 'not-it', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media: fakeMedia(), deniedRetryMs: 40 });
  ua.start();
  await until(() => ua.state === 'denied');
  await until(() => srv.got.filter(m => m.method === 'REGISTER').length >= 4, 2000);
  assert.equal(ua.state, 'denied', 'still denied: the password is still wrong');
  await ua.stop();
});

test('a busy number ends the call with "busy" and ACKs the 486', async () => {
  const srv = harness({ password: 'pw-1234567', busy: true });
  const ua = new SIP.UA({ ext: '1201', password: 'pw-1234567', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media: fakeMedia() });
  ua.start();
  await until(() => ua.state === 'registered');
  const call = await ua.call('1203');
  await until(() => call.state === 'ended');
  assert.equal(call.reason, 'busy');
  assert.equal(srv.got.filter(m => m.method === 'ACK').length, 2);
  await ua.stop();
});

test('incoming: rings with 180, answers with 200 and SDP, ends on the far end\'s BYE; OPTIONS answered', async () => {
  const srv = harness({ password: 'pw-1234567' });
  const media = fakeMedia();
  const ua = new SIP.UA({ ext: '1201', password: 'pw-1234567', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media });
  ua.start();
  await until(() => ua.state === 'registered');
  let incoming = null;
  ua.on('incoming', c => { incoming = c; });
  const inv = 'INVITE sip:abc@x.invalid;transport=ws SIP/2.0\r\nVia: SIP/2.0/WS 127.0.0.1:8088;branch=z9hG4bKin1\r\n' +
    'From: "Ward 2" <sip:1202@pbx>;tag=caller\r\nTo: <sip:1201@pbx>\r\nCall-ID: in-call-1\r\nCSeq: 10 INVITE\r\nContact: <sip:asterisk@127.0.0.1:8088;transport=ws>\r\n' +
    'Content-Type: application/sdp\r\nContent-Length: 10\r\n\r\nv=0\r\ns=-\r\n';
  srv.push(inv);
  await until(() => incoming);
  assert.equal(incoming.number, '1202');
  assert.equal(incoming.name, 'Ward 2');
  const ringing = srv.got.filter(m => m.status === 180).pop();
  assert.ok(ringing && SIP.tagOf(ringing.headers.to[0]), '180 carries our To tag');
  await incoming.answer();
  const ok = srv.got.filter(m => m.status === 200 && /INVITE/.test(m.headers.cseq[0])).pop();
  assert.ok(ok && /^v=0/.test(ok.body), '200 OK carries the answer SDP');
  assert.equal(incoming.state, 'active');
  srv.push('ACK sip:abc@x.invalid SIP/2.0\r\nVia: SIP/2.0/WS 127.0.0.1:8088;branch=z9hG4bKin2\r\nFrom: "Ward 2" <sip:1202@pbx>;tag=caller\r\nTo: <sip:1201@pbx>;tag=' + incoming.localTag + '\r\nCall-ID: in-call-1\r\nCSeq: 10 ACK\r\nContent-Length: 0\r\n\r\n');
  srv.push('BYE sip:abc@x.invalid SIP/2.0\r\nVia: SIP/2.0/WS 127.0.0.1:8088;branch=z9hG4bKin3\r\nFrom: "Ward 2" <sip:1202@pbx>;tag=caller\r\nTo: <sip:1201@pbx>;tag=' + incoming.localTag + '\r\nCall-ID: in-call-1\r\nCSeq: 11 BYE\r\nContent-Length: 0\r\n\r\n');
  await until(() => incoming.state === 'ended');
  assert.equal(incoming.reason, 'the other side hung up');
  assert.ok(srv.got.some(m => m.status === 200 && /BYE/.test(m.headers.cseq[0])), 'BYE answered');
  srv.push('OPTIONS sip:abc@x.invalid SIP/2.0\r\nVia: SIP/2.0/WS 127.0.0.1:8088;branch=z9hG4bKopt\r\nFrom: <sip:asterisk@pbx>;tag=q\r\nTo: <sip:1201@pbx>\r\nCall-ID: q-1\r\nCSeq: 1 OPTIONS\r\nContent-Length: 0\r\n\r\n');
  await until(() => srv.got.some(m => m.status === 200 && /OPTIONS/.test(m.headers.cseq[0])));
  await ua.stop();
});

// ------------------------------------------------------------------------------------------- review fixes, 14 Oct 2026
// an incoming INVITE from the scripted engine, and the CANCEL / ACK that belong to it
const inviteText = id => 'INVITE sip:abc@x.invalid;transport=ws SIP/2.0\r\nVia: SIP/2.0/WS 127.0.0.1:8088;branch=z9hG4bK' + id + '\r\n' +
  'From: "Ward 2" <sip:1202@pbx>;tag=caller\r\nTo: <sip:1201@pbx>\r\nCall-ID: ' + id + '\r\nCSeq: 10 INVITE\r\nContact: <sip:asterisk@127.0.0.1:8088;transport=ws>\r\n' +
  'Content-Type: application/sdp\r\nContent-Length: 10\r\n\r\nv=0\r\ns=-\r\n';
const cancelText = id => 'CANCEL sip:abc@x.invalid;transport=ws SIP/2.0\r\nVia: SIP/2.0/WS 127.0.0.1:8088;branch=z9hG4bK' + id + '\r\n' +
  'From: "Ward 2" <sip:1202@pbx>;tag=caller\r\nTo: <sip:1201@pbx>\r\nCall-ID: ' + id + '\r\nCSeq: 10 CANCEL\r\nContent-Length: 0\r\n\r\n';
const ackText = (id, tag) => 'ACK sip:abc@x.invalid SIP/2.0\r\nVia: SIP/2.0/WS 127.0.0.1:8088;branch=z9hG4bK' + id + 'a\r\nFrom: "Ward 2" <sip:1202@pbx>;tag=caller\r\n' +
  'To: <sip:1201@pbx>;tag=' + tag + '\r\nCall-ID: ' + id + '\r\nCSeq: 10 ACK\r\nContent-Length: 0\r\n\r\n';
// media whose microphone takes as long as the test says, so a call can be caught while it is "connecting"
const slowMedia = () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const m = fakeMedia();
  const create = m.create;
  m.create = async () => { await gate; return create(); };
  m.release = release;
  return m;
};
const finals = (srv, id) => srv.got.filter(x => x.status >= 200 && x.headers['call-id'][0] === id && /INVITE/.test(x.headers.cseq[0])).map(x => x.status);

async function ringingCall(srv, ua, id) {
  let c = null;
  ua.on('incoming', x => { if (x.callId === id) c = x; });
  srv.push(inviteText(id));
  await until(() => c);
  return c;
}

test('hanging up while an incoming call is still connecting refuses it with 603, sends no 200 and no BYE', async () => {
  const srv = harness({ password: 'pw-1234567' }); const media = slowMedia();
  const ua = new SIP.UA({ ext: '1201', password: 'pw-1234567', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media });
  ua.start(); await until(() => ua.state === 'registered');
  const c = await ringingCall(srv, ua, 'conn-hang');
  const answering = c.answer();
  await until(() => c.state === 'connecting');
  c.hangup();
  media.release(); await answering;
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(finals(srv, 'conn-hang'), [603]);
  assert.equal(srv.got.filter(m => m.method === 'BYE').length, 0, 'no BYE on a dialog that never existed');
  await ua.stop();
});

test('a CANCEL that arrives while the call is connecting ends it with 487 and no 200', async () => {
  const srv = harness({ password: 'pw-1234567' }); const media = slowMedia();
  const ua = new SIP.UA({ ext: '1201', password: 'pw-1234567', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media });
  ua.start(); await until(() => ua.state === 'registered');
  const c = await ringingCall(srv, ua, 'conn-cancel');
  const answering = c.answer();
  await until(() => c.state === 'connecting');
  srv.push(cancelText('conn-cancel'));
  media.release(); await answering;
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(finals(srv, 'conn-cancel'), [487]);
  assert.equal(c.reason, 'missed');
  await ua.stop();
});

test('hanging up after answering but before the ACK holds the BYE until the ACK arrives', async () => {
  const srv = harness({ password: 'pw-1234567' });
  const ua = new SIP.UA({ ext: '1201', password: 'pw-1234567', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media: fakeMedia() });
  ua.start(); await until(() => ua.state === 'registered');
  const c = await ringingCall(srv, ua, 'pre-ack');
  await c.answer();
  assert.deepEqual(finals(srv, 'pre-ack'), [200]);
  c.hangup();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(srv.got.filter(m => m.method === 'BYE').length, 0, 'no BYE before the ACK (RFC 3261 section 15)');
  srv.push(ackText('pre-ack', c.localTag));
  await until(() => srv.got.some(m => m.method === 'BYE'));
  await ua.stop();
});

test('a refused REGISTER (503) is retried instead of leaving the phone dead', async () => {
  const srv = harness({ password: 'pw-1234567', regFail: 1 });
  const ua = new SIP.UA({ ext: '1201', password: 'pw-1234567', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media: fakeMedia(), retryMs: 50 });
  const states = [];
  ua.on('state', s => states.push(s));
  ua.start();
  await until(() => ua.state === 'registered');
  assert.ok(states.includes('failed'), 'it did go through failed first');
  await ua.stop();
});

test('a REGISTER that is never answered drops the connection and registers again on a new one', async () => {
  const srv = harness({ password: 'pw-1234567' });
  const ua = new SIP.UA({ ext: '1201', password: 'pw-1234567', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media: fakeMedia(), regTimeoutMs: 60 });
  ua.start(); await until(() => ua.state === 'registered');
  assert.equal(srv.connections, 1);
  srv.silent = true;
  ua.register();
  await until(() => ua.state === 'offline' || ua.state === 'connecting');
  srv.silent = false;
  await until(() => ua.state === 'registered' && srv.connections === 2, 4000);
  await ua.stop();
});

test('a challenge that arrives after the caller hung up does not ring the far end again', async () => {
  const srv = harness({ password: 'pw-1234567' });
  const ua = new SIP.UA({ ext: '1201', password: 'pw-1234567', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media: fakeMedia() });
  ua.start(); await until(() => ua.state === 'registered');
  // hold back the engine's 401 until the caller has hung up
  const ws = ua.ws; const orig = ws.send.bind(ws); let held = null;
  ws.send = text => { if (/^INVITE /.test(text) && !/Authorization:/i.test(text)) { held = text; srv.got.push(SIP.parse(text)); return; } return orig(text); };
  const call = await ua.call('1203');
  await until(() => held);
  call.hangup();
  const inv = SIP.parse(held);
  const h = inv.headers.via.map(v => ['Via', v]);
  h.push(['To', inv.headers.to[0] + ';tag=late'], ['From', inv.headers.from[0]], ['Call-ID', inv.headers['call-id'][0]], ['CSeq', inv.headers.cseq[0]],
    ['WWW-Authenticate', 'Digest realm="asterisk", nonce="late", qop="auth", algorithm=MD5']);
  ws.onmessage({ data: SIP.build('SIP/2.0 401 Unauthorized', h, '') });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(srv.got.filter(m => m.method === 'INVITE').length, 1, 'no second INVITE after the hang-up');
  await ua.stop();
});

// ------------------------------------------------------------------------------------------- modern phone functions, 14 Oct 2026
// Dada: "we need to add modern function call waiting call on hold etc whatever is missing"
const uaFor = (srv, media, o) => new SIP.UA(Object.assign({ ext: '1201', password: 'pw-1234567', domain: 'pbx', wsUrl: 'x', connect: () => srv.connect(), media: media || fakeMedia() }, o || {}));

test('call waiting: a second call rings while one is up, a third is busy; do not disturb sends calls to busy', async () => {
  const srv = harness({ password: 'pw-1234567' });
  const ua = uaFor(srv);
  const rejected = [];
  ua.on('rejected', (c, why) => rejected.push(why));
  ua.start(); await until(() => ua.state === 'registered');
  const first = await ua.call('1202'); await until(() => first.state === 'active');
  const second = await ringingCall(srv, ua, 'cw-2');
  assert.equal(second.waiting, true, 'marked as call waiting');
  assert.ok(srv.got.some(m => m.status === 180 && m.headers['call-id'][0] === 'cw-2'), 'the waiting call is told 180 Ringing');
  assert.deepEqual(finals(srv, 'cw-2'), [], 'and gets no busy');
  srv.push(inviteText('cw-3'));
  await until(() => finals(srv, 'cw-3').length);
  assert.deepEqual(finals(srv, 'cw-3'), [486], 'a third call is busy');
  assert.deepEqual(rejected, ['busy']);
  second.decline(); first.hangup();
  await until(() => ua.calls.size === 0);
  ua.dnd = true;
  srv.push(inviteText('cw-4'));
  await until(() => finals(srv, 'cw-4').length);
  assert.deepEqual(finals(srv, 'cw-4'), [486], 'do not disturb: busy, so the caller reaches voicemail');
  assert.deepEqual(rejected, ['busy', 'do not disturb']);
  // control: with do not disturb off the same call rings
  ua.dnd = false;
  const fifth = await ringingCall(srv, ua, 'cw-5');
  assert.equal(fifth.waiting, false, 'nothing else up: an ordinary call');
  assert.deepEqual(finals(srv, 'cw-5'), []);
  await ua.stop();
});

test('hold silences this phone before the re-INVITE goes out; resume restores audio unless muted', async () => {
  const srv = harness({ password: 'pw-1234567' });
  const media = fakeMedia();
  const ua = uaFor(srv, media);
  ua.start(); await until(() => ua.state === 'registered');
  const call = await ua.call('1202'); await until(() => call.state === 'active');
  media.log.length = 0;
  await call.hold(true);
  assert.deepEqual(media.log.slice(0, 3), ['mute:true', 'dir:sendonly', 'offer'], 'silenced first, then the hold offer');
  await call.hold(false);
  assert.equal(media.log.filter(x => x.startsWith('mute:')).pop(), 'mute:false', 'resumed: audio flows again');
  call.mute(true);
  await call.hold(true); await call.hold(false);
  assert.equal(media.log.filter(x => x.startsWith('mute:')).pop(), 'mute:true', 'muted before the hold: still muted after it');
  call.mute(false);
  call.aside(true);
  assert.equal(media.log.filter(x => x.startsWith('mute:')).pop(), 'mute:true', 'set aside: silent without a hold');
  call.aside(false);
  assert.equal(media.log.filter(x => x.startsWith('mute:')).pop(), 'mute:false');
  await ua.stop();
});

test('transfer to a number: REFER in the dialog, Refer-To and Referred-By exact, ends as transferred', async () => {
  const srv = harness({ password: 'pw-1234567' });
  const ua = uaFor(srv);
  ua.start(); await until(() => ua.state === 'registered');
  const call = await ua.call('1202'); await until(() => call.state === 'active');
  const r = await call.transfer('1203');
  assert.deepEqual(r, { ok: true });
  const refer = srv.last('REFER');
  assert.equal(refer.uri, 'sip:srv@127.0.0.1:8088;transport=ws', 'sent to the far end\'s Contact, inside the dialog');
  assert.equal(refer.headers['refer-to'][0], '<sip:1203@pbx>');
  assert.equal(refer.headers['referred-by'][0], '<sip:1201@pbx>');
  assert.ok(refer.headers.contact && refer.headers.contact[0], 'REFER carries a Contact (RFC 3515)');
  assert.equal(refer.headers['call-id'][0], call.callId);
  await until(() => call.state === 'ended');
  assert.equal(call.reason, 'transferred');
  assert.ok(srv.got.some(m => m.status === 200 && /NOTIFY/.test(m.headers.cseq[0])), 'the NOTIFY is answered');
  await ua.stop();
});

test('after a confirmed transfer the phone leaves the call at once, so the next call is not call waiting', async () => {
  const srv = harness({ password: 'pw-1234567', referNoBye: true }); // Asterisk waits for the transferor's BYE
  const ua = uaFor(srv);
  ua.start(); await until(() => ua.state === 'registered');
  const call = await ua.call('1202'); await until(() => call.state === 'active');
  const r = await call.transfer('1203');
  assert.deepEqual(r, { ok: true });
  await until(() => call.state === 'ended', 500); // not 3 s
  assert.equal(call.reason, 'transferred');
  assert.ok(srv.got.some(m => m.method === 'BYE' && m.headers['call-id'][0] === call.callId), 'the phone sent the BYE');
  const next = await ringingCall(srv, ua, 'after-xfer');
  assert.equal(next.waiting, false, 'a call straight after the transfer rings as an ordinary call');
  await ua.stop();
});

test('a transfer the engine refuses leaves the call up and says why', async () => {
  const srv = harness({ password: 'pw-1234567', referFrag: 'SIP/2.0 404 Not Found' });
  const ua = uaFor(srv);
  ua.start(); await until(() => ua.state === 'registered');
  const call = await ua.call('1202'); await until(() => call.state === 'active');
  const r = await call.transfer('1299');
  assert.deepEqual(r, { ok: false, why: 'not found' });
  assert.equal(call.state, 'active', 'still talking to the same person');
  assert.equal(call.referring, null);
  call.hangup();
  await ua.stop();
});

test('attended transfer: Refer-To carries Replaces with the other call\'s dialog, tags taken from the wire', async () => {
  const srv = harness({ password: 'pw-1234567' });
  const ua = uaFor(srv);
  ua.start(); await until(() => ua.state === 'registered');
  const a = await ua.call('1202'); await until(() => a.state === 'active');
  await a.hold(true);
  const b = await ua.call('1203'); await until(() => b.state === 'active');
  // the tags as they crossed the wire: ours in the From of b's INVITE, the engine's in the To of its 200 OK
  const bInvite = srv.got.filter(m => m.method === 'INVITE' && m.headers['call-id'][0] === b.callId).pop();
  const ourTag = SIP.tagOf(bInvite.headers.from[0]);
  const engineTag = 'srv' + b.callId.slice(0, 4); // what harness() put in the To of its 200
  const r = await a.transfer(null, b);
  assert.deepEqual(r, { ok: true });
  const refer = srv.last('REFER');
  assert.equal(refer.headers['call-id'][0], a.callId, 'the REFER goes to the person on hold');
  const want = '<sip:1203@pbx?Replaces=' + encodeURIComponent(b.callId + ';to-tag=' + engineTag + ';from-tag=' + ourTag) + '>';
  assert.equal(refer.headers['refer-to'][0], want);
  // control: the same header with the tags swapped is a different header - the order is what the engine matches on
  assert.notEqual(refer.headers['refer-to'][0], '<sip:1203@pbx?Replaces=' + encodeURIComponent(b.callId + ';to-tag=' + ourTag + ';from-tag=' + engineTag) + '>');
  assert.equal((await a.transfer(null, a)).ok, false, 'a call cannot be transferred onto itself');
  // the scripted engine hangs up only the call the REFER went to; this phone must leave the other one itself
  // (RFC 5589), or the next call to it rings as call waiting (CI run 38491835492)
  await until(() => b.state === 'ended', 3500);
  assert.equal(b.reason, 'hung up');
  assert.ok(srv.got.some(m => m.method === 'BYE' && m.headers['call-id'][0] === b.callId), 'a BYE for the consultation call');
  await ua.stop();
});

test('ringing on several devices: a CANCEL with Reason cause=200 is "answered elsewhere", a plain CANCEL is missed', async () => {
  const srv = harness({ password: 'pw-1234567' });
  const ua = uaFor(srv);
  ua.start(); await until(() => ua.state === 'registered');
  const c1 = await ringingCall(srv, ua, 'else-1');
  srv.push(cancelText('else-1').replace('CSeq: 10 CANCEL\r\n', 'CSeq: 10 CANCEL\r\nReason: SIP;cause=200;text="Call completed elsewhere"\r\n'));
  await until(() => c1.state === 'ended');
  assert.equal(c1.reason, 'answered elsewhere');
  const c2 = await ringingCall(srv, ua, 'else-2');
  srv.push(cancelText('else-2'));
  await until(() => c2.state === 'ended');
  assert.equal(c2.reason, 'missed', 'control: no Reason header, a missed call');
  await ua.stop();
});

test('an emergency call is recognised only by the exact mark the engine adds', async () => {
  const srv = harness({ password: 'pw-1234567' });
  const ua = uaFor(srv);
  ua.start(); await until(() => ua.state === 'registered');
  const marked = id => inviteText(id).replace('CSeq: 10 INVITE\r\n', 'CSeq: 10 INVITE\r\nX-PMC-Priority: emergency\r\n');
  let got = null; ua.on('incoming', c => { got = c; });
  srv.push(marked('em-1')); await until(() => got && got.callId === 'em-1');
  assert.equal(got.emergency, true);
  got.decline();
  srv.push(inviteText('em-2')); await until(() => got.callId === 'em-2');
  assert.equal(got.emergency, false, 'control: no mark, an ordinary call');
  got.decline();
  srv.push(inviteText('em-3').replace('CSeq: 10 INVITE\r\n', 'CSeq: 10 INVITE\r\nX-PMC-Priority: emergency-ish\r\n'));
  await until(() => got.callId === 'em-3');
  assert.equal(got.emergency, false, 'control: a near miss is not an emergency');
  await ua.stop();
});
