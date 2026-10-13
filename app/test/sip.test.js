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
      ws = {
        sent: [], readyState: 1,
        send(text) {
          const m = SIP.parse(text); got.push(m);
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
