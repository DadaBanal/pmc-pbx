'use strict';
/*
 * A minimal WebSocket client (RFC 6455) over TLS, built-ins only, shaped like a browser WebSocket so app/public/sip.js
 * can use it unchanged. It exists because the browser's WebSocket cannot set a Cookie or an Origin, and the CI test
 * must present both to the admin listener's /ws gate exactly as a signed-in browser page does.
 *
 *   const ws = connect('wss://127.0.0.1:8443/ws', 'sip', { cookie, origin })
 *   ws.onopen / ws.onmessage({ data }) / ws.onclose, ws.send(text), ws.close()
 *
 * Text frames only, client-masked as the RFC requires; answers ping with pong; ignores fragmentation it never sees.
 */
const https = require('https');
const crypto = require('crypto');

function connect(url, protocol, o) {
  o = o || {};
  const u = new URL(url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'));
  const ws = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, status: 0 };
  let socket = null;
  let buf = Buffer.alloc(0);
  const fire = (name, ev) => { const fn = ws[name]; if (fn) fn(ev); };
  const frame = (opcode, payload) => {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
      : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
        : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    return Buffer.concat([head, mask, body]);
  };
  const parse = () => {
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const data = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (opcode === 0x1 || opcode === 0x2) fire('onmessage', { data: data.toString('utf8') });
      else if (opcode === 0x9) socket.write(frame(0xA, data));
      else if (opcode === 0x8) { ws.close(); return; }
    }
  };
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', rejectUnauthorized: false,
    headers: Object.assign({ Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': protocol || 'sip' },
    o.origin ? { Origin: o.origin } : {}, o.cookie ? { Cookie: o.cookie } : {})
  });
  req.on('upgrade', (res, s, head) => {
    socket = s; ws.status = res.statusCode; ws.readyState = 1;
    if (head && head.length) buf = Buffer.concat([buf, head]);
    s.on('data', d => { buf = Buffer.concat([buf, d]); parse(); });
    s.on('close', () => { if (ws.readyState !== 3) { ws.readyState = 3; fire('onclose', {}); } });
    s.on('error', () => {});
    fire('onopen', {});
    parse();
  });
  req.on('response', res => { ws.status = res.statusCode; res.resume(); ws.readyState = 3; fire('onclose', { status: res.statusCode }); });
  req.on('error', e => { ws.readyState = 3; fire('onerror', e); fire('onclose', { error: e.message }); });
  req.end();
  ws.send = text => { if (socket && ws.readyState === 1) socket.write(frame(0x1, Buffer.from(text, 'utf8'))); };
  ws.close = () => { if (ws.readyState === 3) return; ws.readyState = 3; try { socket.write(frame(0x8, Buffer.alloc(0))); socket.end(); } catch (e) { /* gone */ } fire('onclose', {}); };
  return ws;
}

module.exports = { connect };
