/* PMC Phones - the SIP user agent behind the browser phone. SIP over WebSocket (RFC 7118), plain JavaScript,
   no library. Runs in the browser as window.PMCSip and in Node as require('./sip'), so the tests drive exactly
   the code staff use.

   Two things are injected rather than assumed:
     connect(url, protocol) -> an object shaped like a browser WebSocket (send, close, onopen, onmessage, onclose)
     media.create()         -> a session with offer(), setAnswer(sdp), answerOffer(sdp), setDirection(dir),
                               mute(on), dtmf(digit), close()
   In the browser they are window.WebSocket and an RTCPeerConnection. In CI they are a raw WebSocket over TLS and
   a scripted SDP, which lets a real Asterisk prove the signalling without a browser.

   What it does: REGISTER with digest auth and refresh; outgoing and incoming calls; ring, answer, decline,
   cancel, hang up; hold and resume by re-INVITE; DTMF; answers OPTIONS so the engine sees it as reachable.
   Since 14 Oct 2026 (Dada: "we need to add modern function call waiting call on hold etc whatever is missing"):
   call waiting (a second call rings instead of getting busy), do not disturb, transfer by REFER - straight to a
   number or onto another call (RFC 3515, 5589, 3891) - and a held call that hears nothing from this phone. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.PMCSip = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------------------------------------ MD5 (RFC 1321)
  // Web Crypto has no MD5, and SIP digest authentication is MD5. Checked against the RFC 1321 test suite.
  const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const MD5_K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  function md5(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const len = bytes.length;
    const nWords = (((len + 8) >>> 6) + 1) * 16;
    const w = new Uint32Array(nWords);
    for (let i = 0; i < len; i++) w[i >>> 2] |= bytes[i] << ((i % 4) * 8);
    w[len >>> 2] |= 0x80 << ((len % 4) * 8);
    w[nWords - 2] = (len * 8) >>> 0;
    w[nWords - 1] = Math.floor((len * 8) / 4294967296) >>> 0;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let blk = 0; blk < nWords; blk += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + MD5_K[i] + w[blk + g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    let out = '';
    for (const x of [a0, b0, c0, d0]) for (let s = 0; s < 32; s += 8) out += ((x >>> s) & 255).toString(16).padStart(2, '0');
    return out;
  }

  // ------------------------------------------------------------------------------------------------ digest (RFC 2617)
  function parseChallenge(value) {
    const out = {};
    const s = String(value || '').replace(/^\s*Digest\s+/i, '');
    const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
    let m;
    while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
    return out;
  }
  function digestAuthorization(ch, o) {
    const algorithm = String(ch.algorithm || 'MD5').toUpperCase();
    if (algorithm !== 'MD5') throw new Error('the PBX asked for digest algorithm ' + algorithm + ', which this phone does not speak');
    const ha1 = md5(o.username + ':' + ch.realm + ':' + o.password);
    const ha2 = md5(o.method + ':' + o.uri);
    const qops = ch.qop ? ch.qop.split(',').map(x => x.trim().toLowerCase()) : [];
    const parts = ['username="' + o.username + '"', 'realm="' + ch.realm + '"', 'nonce="' + ch.nonce + '"', 'uri="' + o.uri + '"'];
    let response;
    if (qops.includes('auth')) {
      const nc = (o.nc || 1).toString(16).padStart(8, '0');
      response = md5(ha1 + ':' + ch.nonce + ':' + nc + ':' + o.cnonce + ':auth:' + ha2);
      parts.push('response="' + response + '"', 'algorithm=MD5', 'cnonce="' + o.cnonce + '"', 'qop=auth', 'nc=' + nc);
    } else {
      response = md5(ha1 + ':' + ch.nonce + ':' + ha2);
      parts.push('response="' + response + '"', 'algorithm=MD5');
    }
    if (ch.opaque !== undefined) parts.push('opaque="' + ch.opaque + '"');
    return { header: 'Digest ' + parts.join(', '), response };
  }

  // ------------------------------------------------------------------------------------------------ messages
  const COMPACT = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type', k: 'supported', o: 'event', r: 'refer-to', b: 'referred-by' };
  function parse(text) {
    const cut = text.indexOf('\r\n\r\n');
    const head = cut < 0 ? text : text.slice(0, cut);
    const body = cut < 0 ? '' : text.slice(cut + 4);
    const raw = head.split('\r\n');
    const lines = [];
    for (const l of raw) { if (/^[ \t]/.test(l) && lines.length) lines[lines.length - 1] += ' ' + l.trim(); else lines.push(l); }
    const first = lines.shift() || '';
    const msg = { headers: {}, body };
    let m;
    if ((m = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(first))) { msg.status = Number(m[1]); msg.reason = m[2]; }
    else if ((m = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/.exec(first))) { msg.method = m[1]; msg.uri = m[2]; }
    else throw new Error('not a SIP message: ' + first.slice(0, 60));
    for (const l of lines) {
      const i = l.indexOf(':');
      if (i < 1) continue;
      let name = l.slice(0, i).trim().toLowerCase();
      name = COMPACT[name] || name;
      const value = l.slice(i + 1).trim();
      const vals = name === 'via' ? value.split(/,(?=\s*SIP\/2\.0\/)/i).map(x => x.trim()) : [value];
      (msg.headers[name] = msg.headers[name] || []).push(...vals);
    }
    return msg;
  }
  const hdr = (msg, name) => (msg.headers[name] ? msg.headers[name][0] : '');
  const tagOf = v => { const m = /;\s*tag=([^;>\s,]+)/i.exec(v || ''); return m ? m[1] : ''; };
  const uriOf = v => { const m = /<([^>]+)>/.exec(v || ''); return m ? m[1] : String(v || '').split(';')[0].trim(); };
  const branchOf = v => { const m = /;\s*branch=([^;\s,]+)/i.exec(v || ''); return m ? m[1] : ''; };
  const cseqOf = msg => { const m = /^(\d+)\s+([A-Z]+)/.exec(hdr(msg, 'cseq')); return m ? { n: Number(m[1]), method: m[2] } : { n: 0, method: '' }; };
  const userOf = uri => { const m = /^sips?:([^@;>]+)@/.exec(uri || ''); return m ? decodeURIComponent(m[1]) : ''; };
  const nameOf = v => { const m = /^\s*"([^"]*)"/.exec(v || ''); return m ? m[1] : ''; };
  function build(firstLine, headers, body) {
    body = body || '';
    const lines = [firstLine];
    for (const [k, v] of headers) if (v !== undefined && v !== null && v !== '') lines.push(k + ': ' + v);
    lines.push('Content-Length: ' + new TextEncoder().encode(body).length);
    return lines.join('\r\n') + '\r\n\r\n' + body;
  }

  function rand(n) {
    const a = new Uint8Array(n);
    (globalThis.crypto || require('crypto').webcrypto).getRandomValues(a);
    let s = '';
    for (const b of a) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36];
    return s;
  }

  const REASONS = {
    486: 'busy', 600: 'busy', 603: 'declined', 404: 'not found', 484: 'not a complete number', 480: 'not answering',
    408: 'not answering', 487: 'cancelled', 401: 'not authorised', 403: 'not allowed', 407: 'not authorised',
    488: 'could not agree on audio', 503: 'the phone system is busy', 500: 'the phone system failed'
  };
  // what the engine said about a transfer, in words; the sipfrag in its NOTIFY carries one of these codes
  const nfo = s => REASONS[s] || ('the phone system answered ' + s);
  const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, NOTIFY, MESSAGE';

  // ------------------------------------------------------------------------------------------------ the user agent
  class UA {
    constructor(o) {
      this.ext = String(o.ext); this.password = String(o.password); this.displayName = o.name || '';
      this.domain = o.domain; this.wsUrl = o.wsUrl;
      this.connectFn = o.connect; this.media = o.media;
      this.log = o.log || (() => {});
      this.expires = o.expires || 300;
      this.retryMs = o.retryMs || 60000;          // after a refused REGISTER
      this.regTimeoutMs = o.regTimeoutMs || 32000; // REGISTER with no final answer: the connection is dead
      this.deniedRetryMs = o.deniedRetryMs || 120000; // a refused password is tried again, slowly
      this.maxCalls = o.maxCalls || 2;            // call waiting: one call up and one ringing; a third gets busy
      this.dnd = false;                           // do not disturb: new calls get busy, so they go to voicemail
      this.handlers = {};
      this.host = rand(12) + '.invalid';
      this.contact = '<sip:' + rand(8) + '@' + this.host + ';transport=ws>';
      this.reg = { callId: rand(20), tag: rand(10), cseq: 0, timer: null, nonceTried: '' };
      this.tx = new Map();       // client transactions by branch
      this.calls = new Map();    // calls by Call-ID
      this.state = 'offline';
      this.stopped = true; this.backoff = 1000; this.ws = null;
    }
    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
    emit(evt, ...a) { for (const fn of this.handlers[evt] || []) { try { fn(...a); } catch (e) { this.log('handler error ' + e.message); } } }
    setState(s, why) { if (this.state !== s || why) { this.state = s; this.emit('state', s, why || ''); } }

    // -------------------------------------------------------------- connection
    start() { this.stopped = false; this.connect(); return this; }
    connect() {
      this.setState('connecting');
      let ws;
      try { ws = this.connectFn(this.wsUrl, 'sip'); } catch (e) { this.lost('could not open ' + this.wsUrl + ': ' + e.message); return; }
      this.ws = ws;
      ws.onopen = () => { this.backoff = 1000; this.register(); };
      ws.onmessage = ev => this.receive(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      ws.onclose = () => { if (this.ws === ws) this.lost('connection closed'); };
      ws.onerror = () => {};
    }
    lost(why) {
      this.ws = null;
      clearTimeout(this.reg.timer);
      for (const c of this.calls.values()) c.ended('the connection to the phone system dropped');
      this.tx.clear();
      if (this.state !== 'denied') this.setState('offline', why);
      if (!this.stopped) { setTimeout(() => { if (!this.stopped) this.connect(); }, this.backoff); this.backoff = Math.min(this.backoff * 2, 30000); }
    }
    async stop() {
      this.stopped = true;
      for (const c of this.calls.values()) c.hangup();
      if (this.ws && this.state === 'registered') { this.register(0); await new Promise(r => setTimeout(r, 300)); }
      clearTimeout(this.reg.timer);
      if (this.ws) { const ws = this.ws; this.ws = null; try { ws.close(); } catch (e) { /* already closed */ } }
      this.setState('offline', 'signed out');
    }
    send(text) {
      if (!this.ws) return false;
      this.log('>> ' + text.slice(0, text.indexOf('\r\n')));
      try { this.ws.send(text); return true; } catch (e) { return false; }
    }

    // -------------------------------------------------------------- building requests and responses
    request(method, ruri, o) {
      const branch = o.branch || 'z9hG4bK' + rand(14);
      const headers = [
        ['Via', 'SIP/2.0/WS ' + this.host + ';branch=' + branch],
        ['Max-Forwards', '70'],
        ['To', o.to], ['From', o.from], ['Call-ID', o.callId], ['CSeq', o.cseq + ' ' + method],
        ['Contact', o.contact], ['Expires', o.expires], ['Authorization', o.authorization], ['Proxy-Authorization', o.proxyAuthorization],
        ['Allow', method === 'ACK' || method === 'CANCEL' ? '' : ALLOW], ['User-Agent', 'PMC-Phones/1']
      ].concat(o.extra || [], [['Content-Type', o.body ? 'application/sdp' : '']]);
      return { branch, text: build(method + ' ' + ruri + ' SIP/2.0', headers, o.body) };
    }
    respond(req, status, reason, o) {
      o = o || {};
      let to = hdr(req, 'to');
      if (o.toTag && !tagOf(to)) to += ';tag=' + o.toTag;
      const headers = (req.headers.via || []).map(v => ['Via', v]);
      headers.push(['To', to], ['From', hdr(req, 'from')], ['Call-ID', hdr(req, 'call-id')], ['CSeq', hdr(req, 'cseq')]);
      if (o.contact) headers.push(['Contact', o.contact]);
      if (o.allow) headers.push(['Allow', ALLOW]);
      headers.push(['User-Agent', 'PMC-Phones/1'], ['Content-Type', o.body ? 'application/sdp' : '']);
      return this.send(build('SIP/2.0 ' + status + ' ' + reason, headers, o.body));
    }
    me() { return (this.displayName ? '"' + this.displayName.replace(/"/g, '') + '" ' : '') + '<sip:' + this.ext + '@' + this.domain + '>'; }
    authFor(res, method, uri) {
      const isProxy = res.status === 407;
      const ch = parseChallenge(hdr(res, isProxy ? 'proxy-authenticate' : 'www-authenticate'));
      const a = digestAuthorization(ch, { username: this.ext, password: this.password, method, uri, cnonce: rand(16), nc: 1 });
      return isProxy ? { proxyAuthorization: a.header, nonce: ch.nonce } : { authorization: a.header, nonce: ch.nonce };
    }

    // -------------------------------------------------------------- registration
    register(expires, auth) {
      if (expires === undefined) expires = this.expires;
      this.reg.cseq++;
      const ruri = 'sip:' + this.domain;
      const aor = '<sip:' + this.ext + '@' + this.domain + '>';
      const r = this.request('REGISTER', ruri, Object.assign({ to: aor, from: aor + ';tag=' + this.reg.tag, callId: this.reg.callId, cseq: this.reg.cseq,
        contact: this.contact, expires: String(expires) }, auth || {}));
      const ws = this.ws;
      const t = { method: 'REGISTER', expires, authed: !!auth, onResponse: res => { clearTimeout(t.timer); this.onRegister(res, expires, ruri, !!auth); } };
      // no final answer in 32 s (RFC 3261 timer F): the connection is dead even if the socket says otherwise.
      // Close it; the reconnect path registers again. Review 14 Oct 2026: the screen said Ready while it expired.
      t.timer = setTimeout(() => {
        if (!this.tx.has(r.branch)) return;
        this.tx.delete(r.branch);
        this.log('REGISTER got no answer; reconnecting');
        if (this.ws === ws && ws) { try { ws.close(); } catch (e) { /* closing anyway */ } this.lost('the phone system stopped answering'); }
      }, this.regTimeoutMs);
      if (typeof t.timer === 'object' && t.timer.unref) t.timer.unref();
      this.tx.set(r.branch, t);
      this.send(r.text);
    }
    onRegister(res, expires, ruri, authed) {
      if (res.status < 200) return;
      if (res.status === 401 || res.status === 407) {
        // refused after the challenge: wrong password, or (14 Oct 2026, kevin.cadano) an extension the engine had not
        // loaded yet. Try again every 2 minutes instead of stopping for good, so the phone recovers on its own.
        if (authed) {
          this.setState('denied', 'the phone system did not accept this phone\'s password');
          clearTimeout(this.reg.timer);
          this.reg.timer = setTimeout(() => { if (!this.stopped && this.ws) this.register(); }, this.deniedRetryMs);
          if (typeof this.reg.timer === 'object' && this.reg.timer.unref) this.reg.timer.unref();
          return;
        }
        return this.register(expires, this.authFor(res, 'REGISTER', ruri));
      }
      if (res.status >= 200 && res.status < 300) {
        if (expires === 0) return;
        const m = /;\s*expires=(\d+)/i.exec(hdr(res, 'contact'));
        const granted = Number(m ? m[1] : hdr(res, 'expires')) || expires;
        clearTimeout(this.reg.timer);
        this.reg.timer = setTimeout(() => this.register(), Math.max(30, granted * 0.85) * 1000);
        if (typeof this.reg.timer === 'object' && this.reg.timer.unref) this.reg.timer.unref();
        this.setState('registered');
        return;
      }
      // any other refusal (403, 408, 5xx) is retried a minute later instead of leaving the phone dead until reload
      this.setState('failed', 'registration refused: ' + res.status + ' ' + res.reason);
      clearTimeout(this.reg.timer);
      this.reg.timer = setTimeout(() => { if (!this.stopped && this.ws) this.register(); }, this.retryMs);
      if (typeof this.reg.timer === 'object' && this.reg.timer.unref) this.reg.timer.unref();
    }

    // -------------------------------------------------------------- everything that arrives
    receive(text) {
      if (!text.trim()) return;
      let msg;
      try { msg = parse(text); } catch (e) { this.log('ignored: ' + e.message); return; }
      this.log('<< ' + (msg.method ? msg.method + ' ' + msg.uri : msg.status + ' ' + msg.reason));
      if (msg.status) {
        const t = this.tx.get(branchOf(hdr(msg, 'via')));
        if (!t || cseqOf(msg).method !== t.method) return;
        if (msg.status >= 200) this.tx.delete(branchOf(hdr(msg, 'via')));
        Promise.resolve(t.onResponse(msg)).catch(e => this.log('response handler: ' + e.message));
        return;
      }
      const callId = hdr(msg, 'call-id');
      const call = this.calls.get(callId);
      switch (msg.method) {
        case 'OPTIONS': return this.respond(msg, 200, 'OK', { allow: true, contact: this.contact });
        case 'INVITE':
          if (call && tagOf(hdr(msg, 'to'))) return call.onReinvite(msg);
          if (call) return; // retransmission of an INVITE we are already handling
          return this.onIncoming(msg);
        case 'ACK': if (call) call.onAck(msg); return;
        case 'CANCEL': {
          this.respond(msg, 200, 'OK');
          // ringing on several of the person's devices: the engine cancels the others with Reason cause=200 when
          // one answers (RFC 3326). That is not a missed call.
          const elsewhere = /cause\s*=\s*200\b/i.test((msg.headers.reason || []).join(','));
          if (call && call.dir === 'in' && (call.state === 'ringing' || call.state === 'connecting')) call.cancelled(elsewhere ? 'answered elsewhere' : 'missed');
          return;
        }
        case 'BYE':
          this.respond(msg, call ? 200 : 481, call ? 'OK' : 'Call Does Not Exist');
          if (call && call.referring) call.referring.finish({ ok: true }); // the engine ends our leg once the transfer holds
          if (call) call.ended(call.transferred || call.referring === false ? 'transferred' : 'the other side hung up');
          return;
        case 'NOTIFY':
          this.respond(msg, 200, 'OK');
          if (call && /^refer/i.test(hdr(msg, 'event'))) call.onReferNotify(msg);
          return;
        case 'INFO': case 'MESSAGE': return this.respond(msg, 200, 'OK');
        default: return this.respond(msg, 405, 'Method Not Allowed', { allow: true });
      }
    }
    onIncoming(invite) {
      const live = Array.from(this.calls.values()).filter(c => c.state !== 'ended');
      const c = new Call(this, 'in');
      c.callId = hdr(invite, 'call-id');
      c.localTag = rand(10);
      c.invite = invite;
      c.localUri = hdr(invite, 'to');
      c.remoteUri = hdr(invite, 'from');
      c.remoteTag = tagOf(c.remoteUri);
      c.remoteTarget = uriOf(hdr(invite, 'contact')) || uriOf(c.remoteUri);
      c.remoteCseq = cseqOf(invite).n;
      c.number = userOf(uriOf(c.remoteUri));
      c.name = nameOf(c.remoteUri);
      if (this.dnd || live.length >= this.maxCalls) {
        this.respond(invite, 486, 'Busy Here', { toTag: c.localTag });
        this.emit('rejected', c, this.dnd ? 'do not disturb' : 'busy');
        return;
      }
      c.waiting = live.length > 0; // call waiting: this phone is already on a call
      this.calls.set(c.callId, c);
      c.state = 'ringing';
      this.respond(invite, 180, 'Ringing', { toTag: c.localTag, contact: this.contact });
      this.emit('incoming', c);
      this.emit('call', c);
    }

    // -------------------------------------------------------------- placing a call
    async call(target) {
      const number = String(target || '').replace(/[^0-9*#+]/g, '');
      if (!number) throw new Error('type a number first');
      if (!this.ws || this.state !== 'registered') throw new Error('this phone is not connected yet');
      const c = new Call(this, 'out');
      c.number = number;
      c.callId = rand(22); c.localTag = rand(10); c.cseq = 1;
      c.localUri = this.me() + ';tag=' + c.localTag;
      c.ruri = 'sip:' + number + '@' + this.domain;
      c.remoteUri = '<' + c.ruri + '>';
      c.state = 'calling';
      this.calls.set(c.callId, c);
      this.emit('call', c);
      try {
        c.session = await this.media.create();
        const offer = await c.session.offer();
        if (c.state === 'ended') { c.session.close(); return c; }
        c.sendInvite(offer, null);
      } catch (e) {
        c.ended(e && e.name === 'NotAllowedError' ? 'the microphone is blocked for this page' : 'could not start the call: ' + (e && e.message || e));
      }
      return c;
    }
  }

  // ------------------------------------------------------------------------------------------------ a call
  class Call {
    constructor(ua, dir) {
      this.ua = ua; this.dir = dir; this.state = 'new'; this.reason = ''; this.muted = false; this.held = false; this.asideOn = false;
      this.referring = null; this.transferred = false; this.holding = false;
      this.number = ''; this.name = ''; this.startedAt = 0; this.endedAt = 0; this.cseq = 0; this.session = null;
      this.okTimer = null; this.inviteBranch = ''; this.remoteSdpSet = false;
    }
    set(state) { this.state = state; this.ua.emit('update', this); }
    dialogHeaders(method, cseq) {
      return { to: (this.dir === 'out' ? this.remoteUri : this.remoteUri), from: this.localUri, callId: this.callId, cseq, contact: method === 'ACK' || method === 'BYE' ? '' : this.ua.contact };
    }
    // ---------------- outgoing INVITE and its responses
    sendInvite(sdp, auth) {
      const r = this.ua.request('INVITE', this.ruri, Object.assign({ to: this.remoteUri, from: this.localUri, callId: this.callId, cseq: this.cseq, contact: this.ua.contact, body: sdp }, auth || {}));
      this.inviteBranch = r.branch; this.offer = sdp;
      this.ua.tx.set(r.branch, { method: 'INVITE', onResponse: res => this.onInviteResponse(res, !!auth, r.branch) });
      this.ua.send(r.text);
    }
    ackFailure(res, branch, ruri) {
      // ACK for a non-2xx final response: same branch, CSeq number and Request-URI as the request it answers.
      // An incoming call has no this.ruri: a failed re-INVITE (hold) was sent to the remote target.
      const target = ruri || this.ruri || this.remoteTarget;
      const ackHeaders = [['Via', 'SIP/2.0/WS ' + this.ua.host + ';branch=' + branch], ['Max-Forwards', '70'], ['To', hdr(res, 'to')],
        ['From', this.localUri], ['Call-ID', this.callId], ['CSeq', cseqOf(res).n + ' ACK']];
      this.ua.send(build('ACK ' + target + ' SIP/2.0', ackHeaders, ''));
    }
    async onInviteResponse(res, authed, branch) {
      if (res.status === 100) return;
      if (res.status < 200) {
        if (this.state === 'calling') this.set('ringing');
        if (res.body && !this.remoteSdpSet && /^v=0/m.test(res.body)) { this.remoteSdpSet = true; await this.session.setAnswer(res.body); }
        if (this.cancelWanted) this.sendCancel();
        return;
      }
      if (res.status < 300) {
        const firstFinal = !this.remoteTag;
        this.remoteTag = tagOf(hdr(res, 'to'));
        this.remoteUri = hdr(res, 'to');
        this.remoteTarget = uriOf(hdr(res, 'contact')) || this.ruri;
        const ack = this.ua.request('ACK', this.remoteTarget, { to: this.remoteUri, from: this.localUri, callId: this.callId, cseq: this.cseq });
        this.ua.send(ack.text);
        if (!firstFinal) return;
        if (this.state === 'ended') { this.sendBye(); return; } // hung up while it was being answered
        if (!this.remoteSdpSet && res.body) { this.remoteSdpSet = true; await this.session.setAnswer(res.body); }
        this.startedAt = Date.now();
        this.set('active');
        return;
      }
      this.ackFailure(res, branch, this.ruri);
      // a challenge that arrives after the caller hung up must not ring the far end again
      if ((res.status === 401 || res.status === 407) && !authed && this.state !== 'ended') {
        this.cseq++;
        return this.sendInvite(this.offer, this.ua.authFor(res, 'INVITE', this.ruri));
      }
      this.ended(this.state === 'ended' ? this.reason : (res.status === 487 ? 'cancelled' : (REASONS[res.status] || res.status + ' ' + res.reason)), res.status);
    }
    sendCancel() {
      this.cancelWanted = false;
      const headers = [['Via', 'SIP/2.0/WS ' + this.ua.host + ';branch=' + this.inviteBranch], ['Max-Forwards', '70'], ['To', '<' + this.ruri + '>'],
        ['From', this.localUri], ['Call-ID', this.callId], ['CSeq', this.cseq + ' CANCEL']];
      this.ua.send(build('CANCEL ' + this.ruri + ' SIP/2.0', headers, ''));
    }
    // ---------------- in-dialog requests we send
    inDialog(method, body, onResponse, extra) {
      this.cseq++;
      const r = this.ua.request(method, this.remoteTarget, { to: this.remoteUri, from: this.localUri, callId: this.callId, cseq: this.cseq,
        contact: method === 'INVITE' || method === 'REFER' ? this.ua.contact : '', body, extra });
      if (onResponse) this.ua.tx.set(r.branch, { method, onResponse: res => onResponse(res, r.branch) });
      this.ua.send(r.text);
    }
    sendBye() { this.inDialog('BYE', '', () => {}); }
    // ---------------- incoming call
    async answer() {
      if (this.dir !== 'in' || this.state !== 'ringing') return;
      this.set('connecting');
      try {
        this.session = await this.ua.media.create();
        const answer = await this.session.answerOffer(this.invite.body);
        if (this.state === 'ended') { this.session.close(); return; }
        this.localUri = hdr(this.invite, 'to') + (tagOf(hdr(this.invite, 'to')) ? '' : ';tag=' + this.localTag);
        this.answerSdp = answer;
        const send = () => this.ua.respond(this.invite, 200, 'OK', { toTag: this.localTag, contact: this.ua.contact, body: answer });
        send();
        // a 2xx is retransmitted until the ACK arrives, even over a reliable transport (RFC 3261 13.3.1.4)
        let wait = 500, spent = 0;
        const again = () => { if ((this.state !== 'active' && !this.byeAfterAck) || this.acked) return; spent += wait; if (spent > 32000) { this.ended('the phone system never confirmed the answer'); this.sendBye(); return; } send(); wait = Math.min(wait * 2, 4000); this.okTimer = setTimeout(again, wait); };
        this.okTimer = setTimeout(again, wait);
        this.startedAt = Date.now();
        this.set('active');
      } catch (e) {
        this.ua.respond(this.invite, 488, 'Not Acceptable Here', { toTag: this.localTag });
        this.ended(e && e.name === 'NotAllowedError' ? 'the microphone is blocked for this page' : 'could not answer: ' + (e && e.message || e));
      }
    }
    decline() {
      if (this.dir !== 'in' || this.state !== 'ringing') return;
      this.ua.respond(this.invite, 486, 'Busy Here', { toTag: this.localTag });
      this.ended('declined');
    }
    cancelled(why) { this.ua.respond(this.invite, 487, 'Request Terminated', { toTag: this.localTag }); this.ended(why || 'missed'); }
    onAck() { this.acked = true; clearTimeout(this.okTimer); if (this.byeAfterAck) { this.byeAfterAck = false; this.sendBye(); } }
    async onReinvite(req) {
      // the far end changed the media: hold music, resume, a codec change
      this.remoteCseq = cseqOf(req).n;
      try {
        const answer = await this.session.answerOffer(req.body);
        this.ua.respond(req, 200, 'OK', { contact: this.ua.contact, body: answer });
      } catch (e) {
        this.ua.respond(req, 488, 'Not Acceptable Here');
      }
    }
    // ---------------- controls
    hangup() {
      if (this.state === 'ended') return;
      if (this.dir === 'in' && this.state === 'ringing') return this.decline();
      if (this.state === 'calling' || this.state === 'ringing') {
        if (this.inviteBranch) this.sendCancel(); else this.cancelWanted = true;
        this.ended('cancelled');
        return;
      }
      if (this.dir === 'in' && this.state === 'connecting') {
        // the 200 has not gone out yet (answer() checks for this before sending it): refuse the INVITE instead
        this.ua.respond(this.invite, 603, 'Decline', { toTag: this.localTag });
        this.ended('hung up');
        return;
      }
      // RFC 3261 15: the callee may not send BYE until its 200 is acknowledged; send it when the ACK arrives
      if (this.dir === 'in' && this.state === 'active' && !this.acked) { this.byeAfterAck = true; this.ended('hung up'); return; }
      if (this.state === 'active') this.sendBye();
      this.ended('hung up');
    }
    // what the far end hears from this phone: nothing while muted, held or set aside
    sendAudio() { if (this.session) this.session.mute(this.muted || this.held || this.asideOn); }
    async hold(on) {
      if (this.state !== 'active' || !!on === this.held || this.holding) return;
      this.holding = true; this.ua.emit('update', this);
      // a held call must not hear this phone: before 14 Oct 2026 hold only changed the SDP direction, so the person on
      // hold could hear your next call
      if (on && this.session) this.session.mute(true);
      this.session.setDirection(on ? 'sendonly' : 'sendrecv');
      try {
        const offer = await this.session.offer();
        await new Promise(resolve => {
          this.inDialog('INVITE', offer, async (res, branch) => {
            if (res.status < 200) return;
            if (res.status < 300) {
              const ack = this.ua.request('ACK', this.remoteTarget, { to: this.remoteUri, from: this.localUri, callId: this.callId, cseq: this.cseq });
              this.ua.send(ack.text);
              try { await this.session.setAnswer(res.body); } catch (e) { /* keep the call */ }
              this.held = !!on;
            } else { this.ackFailure(res, branch, this.remoteTarget); this.session.setDirection(this.held ? 'sendonly' : 'sendrecv'); }
            resolve();
          });
        });
      } finally {
        this.holding = false;
        this.sendAudio();
        this.ua.emit('update', this);
      }
    }
    // stop sending audio without a hold: a conference stays live for the others while you take another call
    aside(on) { this.asideOn = !!on; this.sendAudio(); this.ua.emit('update', this); }
    mute(on) { this.muted = !!on; this.sendAudio(); this.ua.emit('update', this); }
    // ---------------- transfer
    // number: send the far end to that number (blind). other: connect the far end to the person on that other call
    // (attended; Refer-To carries Replaces with the other call's dialog, RFC 3891: to-tag is the engine's tag on it,
    // from-tag ours). Resolves { ok, why } once the engine's NOTIFY says how it went, or 30 s pass.
    transfer(number, other) {
      const no = why => Promise.resolve({ ok: false, why });
      if (this.state !== 'active') return no('the call is not connected');
      if (this.referring) return no('a transfer is already under way');
      let target;
      if (other) {
        if (other === this || other.state !== 'active' || !other.remoteTag) return no('the other call is not connected');
        const replaces = encodeURIComponent(other.callId + ';to-tag=' + other.remoteTag + ';from-tag=' + other.localTag);
        target = 'sip:' + (other.number || 'transfer') + '@' + this.ua.domain + '?Replaces=' + replaces;
      } else {
        const n = String(number || '').replace(/[^0-9*#+]/g, '');
        if (!n) return no('no number to transfer to');
        target = 'sip:' + n + '@' + this.ua.domain;
      }
      return new Promise(resolve => {
        let timer = null;
        const finish = r => {
          if (!this.referring) return;
          clearTimeout(timer);
          this.referring = r.ok ? false : null;
          if (r.ok) {
            this.transferred = true;
            // the engine normally ends our leg itself; if it has not within 3 s, end it (RFC 5589 6.1)
            const t = setTimeout(() => { if (this.state === 'active') { this.sendBye(); this.ended('transferred'); } }, 3000);
            if (typeof t === 'object' && t.unref) t.unref();
            // attended: this phone leaves the other call too (RFC 5589: the transferor ends both dialogs). Without it a
            // call the engine has already handed over stays up here, and the next call rings as call waiting or busy
            // (CI run 38491835492, 14 Oct 2026: the blind transfer that followed never reached B)
            if (other) {
              const t2 = setTimeout(() => { if (other.state === 'active') other.hangup(); }, 2000);
              if (typeof t2 === 'object' && t2.unref) t2.unref();
            }
          }
          this.ua.emit('update', this);
          resolve(r);
        };
        this.referring = { finish, target };
        timer = setTimeout(() => finish({ ok: false, why: 'the phone system did not confirm the transfer' }), 30000);
        if (typeof timer === 'object' && timer.unref) timer.unref();
        this.ua.emit('update', this);
        this.inDialog('REFER', '', res => {
          if (res.status >= 300) finish({ ok: false, why: nfo(res.status) });
          // 202 Accepted: the outcome follows in NOTIFY
        }, [['Refer-To', '<' + target + '>'], ['Referred-By', '<sip:' + this.ua.ext + '@' + this.ua.domain + '>']]);
      });
    }
    onReferNotify(msg) {
      if (!this.referring) return;
      const m = /^SIP\/2\.0\s+(\d{3})/m.exec(msg.body || '');
      if (!m || Number(m[1]) < 200) return; // 100 Trying, 180 Ringing: still going
      const code = Number(m[1]);
      this.referring.finish(code < 300 ? { ok: true } : { ok: false, why: nfo(code) });
    }
    dtmf(digit) { if (this.state === 'active' && this.session && /^[0-9*#A-D]$/.test(digit)) this.session.dtmf(digit); }
    ended(reason, status) {
      if (this.state === 'ended') return;
      if (this.referring) this.referring.finish({ ok: false, why: 'the call ended before the transfer was confirmed' });
      this.reason = reason || this.reason; this.status = status || 0;
      this.endedAt = Date.now();
      clearTimeout(this.okTimer);
      if (this.session) { try { this.session.close(); } catch (e) { /* already closed */ } }
      this.set('ended');
      if (this.byeAfterAck) setTimeout(() => this.ua.calls.delete(this.callId), 32000); // keep it to catch the ACK
      else this.ua.calls.delete(this.callId);
    }
  }

  return { UA, Call, md5, digestAuthorization, parseChallenge, parse, build, tagOf, uriOf, branchOf, userOf, REASONS };
});
