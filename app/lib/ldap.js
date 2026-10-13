'use strict';
// A minimal LDAP v3 client over TLS, Node built-ins only: simple bind, then subtree searches. Enough to check a
// person's Active Directory password and whether they are in a group (Dada, 13 Oct 2026: "a separate user list that
// is link to the ad"). The pattern follows the Employee Portal's ldapBind (C:\PMC\payroll\bridge.js); this one adds
// search and a pinned certificate, because DND-AD01's LDAPS certificate is self-signed (CN=DND-AD01, to 2031).
//
// SECURITY: an empty password is an ANONYMOUS bind and AD answers success. bind() refuses it before any byte is sent.
const tls = require('tls');

// ------------------------------------------------------------------ BER
function berLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | bytes.length].concat(bytes));
}
const tlv = (tag, payload) => Buffer.concat([Buffer.from([tag]), berLen(payload.length), payload]);
const seq = (tag, parts) => tlv(tag, Buffer.concat(parts));
const str = (tag, s) => tlv(tag, Buffer.from(String(s), 'utf8'));
const int = (tag, n) => { const b = []; do { b.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0); if (b[0] & 0x80) b.unshift(0); return tlv(tag, Buffer.from(b)); };
const bool = (tag, v) => tlv(tag, Buffer.from([v ? 0xff : 0]));

// one TLV at offset i -> { tag, start (of value), end, next } or null if the buffer does not hold all of it yet
function readTlv(buf, i) {
  if (i + 2 > buf.length) return null;
  const tag = buf[i];
  let len = buf[i + 1], p = i + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    // Active Directory writes EVERY long-form length in 4 bytes (0x84 00 00 00 xx), however small the value. 14 Oct
    // 2026: a cap of 3 length bytes refused every real reply and broke all sign-ins. Cap the VALUE instead.
    if (n < 1 || n > 4) throw new Error('BER length of ' + n + ' bytes');
    if (p + n > buf.length) return null;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[p + k];
    if (len > 16 * 1024 * 1024) throw new Error('BER length ' + len + ' is beyond anything the directory sends');
    p += n;
  }
  if (p + len > buf.length) return null;
  return { tag, start: p, end: p + len, next: p + len };
}
// the children of a constructed TLV
function children(buf, t) {
  const out = [];
  for (let i = t.start; i < t.end;) { const c = readTlv(buf, i); if (!c) throw new Error('truncated BER'); out.push(c); i = c.next; }
  return out;
}
const text = (buf, t) => buf.toString('utf8', t.start, t.end);
const num = (buf, t) => { let n = 0; for (let i = t.start; i < t.end; i++) n = n * 256 + buf[i]; return n; };

// ------------------------------------------------------------------ filters (RFC 4511 section 4.5.1)
// { and: [...] } | { eq: [attr, value] } | { inChain: [attr, dn] } (AD's LDAP_MATCHING_RULE_IN_CHAIN, nested groups)
const IN_CHAIN = '1.2.840.113556.1.4.1941';
function filter(f) {
  if (f.and) return seq(0xa0, f.and.map(filter));
  if (f.eq) return seq(0xa3, [str(0x04, f.eq[0]), str(0x04, f.eq[1])]);
  if (f.inChain) return seq(0xa9, [str(0x81, IN_CHAIN), str(0x82, f.inChain[0]), str(0x83, f.inChain[1])]);
  throw new Error('unsupported filter');
}

// ------------------------------------------------------------------ messages
const bindRequest = (id, name, password) => seq(0x30, [int(0x02, id), seq(0x60, [int(0x02, 3), str(0x04, name), str(0x80, password)])]);
const searchRequest = (id, base, f, attrs, sizeLimit) => seq(0x30, [int(0x02, id), seq(0x63, [
  str(0x04, base), tlv(0x0a, Buffer.from([2])), tlv(0x0a, Buffer.from([0])), int(0x02, sizeLimit || 10), int(0x02, 10),
  bool(0x01, false), filter(f), seq(0x30, attrs.map(a => str(0x04, a)))])]);
const unbindRequest = id => seq(0x30, [int(0x02, id), tlv(0x42, Buffer.alloc(0))]);

// AD's reason inside a failed bind: "data 52e" wrong password, 525 no such user, 533 disabled, 775 locked, 532/773 expired
const AD_REASONS = { '52e': 'wrong password', '525': 'no such user', '533': 'account disabled', '775': 'account locked out', '532': 'password expired', '773': 'password must be changed', '701': 'account expired', '530': 'not allowed at this time', '531': 'not allowed from this computer' };

// connect -> { bind, search, close }. opts: { url, servername, pin (SHA-256 fingerprint, AA:BB:..), timeoutMs }
function connect(opts) {
  return new Promise((resolve, reject) => {
    const m = /^ldaps:\/\/([^:/\s]+)(?::(\d+))?\/?$/i.exec(String(opts.url || ''));
    if (!m) return reject(new Error('ldap url must be ldaps://host[:port]'));
    if (!opts.pin) return reject(new Error('no certificate pin configured for the directory'));
    const timeoutMs = opts.timeoutMs || 5000;
    let buf = Buffer.alloc(0), nextId = 1, closed = null;
    const waiting = new Map(); // id -> { onMsg(op, opTlv) }
    const sock = tls.connect({ host: m[1], port: parseInt(m[2] || '636', 10), servername: opts.servername || undefined, rejectUnauthorized: false });
    const fail = err => {
      if (closed) return;
      closed = err;
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
      try { sock.destroy(); } catch (e) { /* gone */ }
    };
    const timer = setTimeout(() => { fail(new Error('directory did not answer in ' + timeoutMs + ' ms')); reject(closed); }, timeoutMs);
    sock.on('error', e => { fail(e); reject(e); });
    sock.on('close', () => fail(new Error('directory closed the connection')));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      try {
        for (;;) {
          const t = readTlv(buf, 0);
          if (!t) break;
          const [idT, opT] = children(buf, t);
          const w = waiting.get(num(buf, idT));
          if (w) w.onMsg(buf.subarray(0, t.next), opT);
          buf = buf.subarray(t.next);
        }
      } catch (e) { fail(e); }
    });
    sock.once('secureConnect', () => {
      // the pin is the whole trust decision: the certificate is self-signed, so no CA can vouch for it
      const fp = (sock.getPeerCertificate() || {}).fingerprint256 || '';
      if (fp.toUpperCase() !== String(opts.pin).toUpperCase()) {
        clearTimeout(timer);
        const e = new Error('directory certificate ' + (fp || 'none') + ' does not match the pinned one');
        fail(e); return reject(e);
      }
      // every request has its own deadline: a controller that accepts TLS and then stops answering must not hang a
      // sign-in forever (review 14 Oct 2026; the only timer used to be the handshake's)
      const call = (msg, collect) => new Promise((res, rej) => {
        if (closed) return rej(closed);
        const id = nextId++;
        const timer = setTimeout(() => { fail(new Error('directory stopped answering after ' + timeoutMs + ' ms')); }, timeoutMs);
        waiting.set(id, { reject: e => { clearTimeout(timer); rej(e); }, onMsg: (b, op) => { const r = collect(b, op); if (r !== undefined) { clearTimeout(timer); waiting.delete(id); res(r); } } });
        sock.write(msg(id));
      });
      const resultOf = (b, op) => { const c = children(b, op); const code = num(b, c[0]); const diag = c[2] ? text(b, c[2]) : ''; return { code, diag }; };
      clearTimeout(timer);
      resolve({
        // -> { ok: true } | { ok: false, reason }
        bind(name, password) {
          if (!String(password || '').length) return Promise.resolve({ ok: false, reason: 'empty password' });
          return call(id => bindRequest(id, name, password), (b, op) => {
            if (op.tag !== 0x61) return { ok: false, reason: 'unexpected answer' };
            const r = resultOf(b, op);
            if (r.code === 0) return { ok: true };
            const sub = (/data\s+([0-9a-f]{3})/i.exec(r.diag) || [])[1];
            return { ok: false, code: r.code, reason: (sub && AD_REASONS[sub.toLowerCase()]) || (r.code === 49 ? 'wrong name or password' : 'directory refused (' + r.code + ')') };
          });
        },
        // -> [{ dn, attrs: { name: [values] } }]
        search(base, f, attrs, sizeLimit) {
          const entries = [];
          return call(id => searchRequest(id, base, f, attrs, sizeLimit), (b, op) => {
            if (op.tag === 0x64) {
              const [dnT, attrsT] = children(b, op);
              const a = {};
              for (const at of children(b, attrsT)) { const [typeT, valsT] = children(b, at); a[text(b, typeT)] = children(b, valsT).map(v => text(b, v)); }
              entries.push({ dn: text(b, dnT), attrs: a });
              return undefined;
            }
            if (op.tag === 0x65) {
              const r = resultOf(b, op);
              if (r.code !== 0 && r.code !== 4) throw new Error('directory search failed (' + r.code + ')'); // 4 = size limit hit
              return entries;
            }
            return undefined; // 0x73 referrals: not followed
          });
        },
        close() { try { if (!closed) sock.end(unbindRequest(nextId++)); } catch (e) { /* gone */ } }
      });
    });
  });
}

// A sign-in name as people type it -> the sAMAccountName, or null. Accepts "jdoe", "PMCNE\jdoe", "jdoe@pmcne.ph".
function accountName(typed, upnSuffix) {
  let s = String(typed || '').trim();
  const bs = s.indexOf('\\');
  if (bs >= 0) { if (!/^[a-z0-9-]{1,15}$/i.test(s.slice(0, bs))) return null; s = s.slice(bs + 1); } // DOMAIN\name
  const at = s.indexOf('@');
  if (at >= 0) { if (upnSuffix && s.slice(at).toLowerCase() !== upnSuffix.toLowerCase()) return null; s = s.slice(0, at); }
  s = s.toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s) ? s : null;
}

// Check a person: their password (by binding as them), then that they are in one of the groups, nested membership
// included. -> { ok: true, sam, name } | { ok: false, reason, unavailable? }
async function checkPerson(ad, typed, password) {
  const sam = accountName(typed, ad.upnSuffix);
  if (!sam) return { ok: false, reason: 'not a domain account name' };
  if (!String(password || '').length) return { ok: false, reason: 'empty password' };
  let c;
  try { c = await connect(ad); } catch (e) { return { ok: false, unavailable: true, reason: 'directory unavailable: ' + e.message }; }
  try {
    const b = await c.bind(sam + ad.upnSuffix, password);
    if (!b.ok) return { ok: false, reason: b.reason };
    for (const group of ad.groups) {
      const g = await c.search(ad.baseDN, { and: [{ eq: ['objectClass', 'group'] }, { eq: ['cn', group] }] }, ['distinguishedName'], 2);
      if (g.length !== 1) continue;
      const u = await c.search(ad.baseDN, { and: [{ eq: ['sAMAccountName', sam] }, { inChain: ['memberOf', g[0].dn] }] }, ['sAMAccountName', 'displayName'], 2);
      if (u.length === 1) {
        const a = u[0].attrs;
        return { ok: true, sam, name: ((a.displayName || [])[0] || sam), group };
      }
    }
    return { ok: false, reason: 'not in ' + ad.groups.join(' or ') };
  } catch (e) {
    return { ok: false, unavailable: true, reason: 'directory error: ' + e.message };
  } finally { c.close(); }
}

module.exports = { connect, checkPerson, accountName, filter, readTlv, children, text, num, tlv, seq, str, int, AD_REASONS };
