'use strict';
// A stand-in for DND-AD01's LDAPS port: answers simple binds and the two searches lib/ldap.js makes, from a small
// table of people. It refuses any search before a successful bind, as AD does for these attributes, and counts every
// bind it receives so a test can prove that a refused sign-in never reached the directory at all.
const tls = require('tls');
const L = require('../lib/ldap');

// AD writes every long-form BER length as 0x84 + 4 bytes, even for 5. Re-encode the stand-in's replies the same way so
// the client is tested against what DND-AD01 really sends (14 Oct 2026: a 3-byte cap passed every test and broke prod).
function adStyle(buf) { const parts = []; walkInto(buf, parts); return Buffer.concat(parts); }
function walkInto(b, parts) {
  let i = 0;
  while (i < b.length) {
    const t = L.readTlv(b, i);
    let inner = b.subarray(t.start, t.end);
    if ((b[i] & 0x20) !== 0) { const sub = []; walkInto(inner, sub); inner = Buffer.concat(sub); } // constructed: re-encode inside too
    const n = inner.length;
    parts.push(Buffer.from([b[i], 0x84, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]), inner);
    i = t.next;
  }
}

const GROUP_DN = 'CN=PMO Team,OU=Groups,DC=pmcne,DC=ph';

// people: { sam: { password, name, groups: [cn], sub } }  sub = AD's "data xxx" reason to send instead of success
function fakeDc(cert, key, people) {
  const seen = { binds: [], searches: 0, connections: 0 };
  const done = (id, tag, code, diag) => L.seq(0x30, [L.int(0x02, id), L.seq(tag, [L.tlv(0x0a, Buffer.from([code])), L.str(0x04, ''), L.str(0x04, diag || '')])]);
  const entry = (id, dn, attrs) => L.seq(0x30, [L.int(0x02, id), L.seq(0x64, [L.str(0x04, dn), L.seq(0x30,
    Object.entries(attrs).map(([k, v]) => L.seq(0x30, [L.str(0x04, k), L.seq(0x31, [L.str(0x04, v)])])))])]);
  // the filter's leaves, flattened: [{ kind: 'eq'|'inChain', attr, value }]
  function leaves(buf, t, out) {
    if (t.tag === 0xa0) { for (const c of L.children(buf, t)) leaves(buf, c, out); return out; }
    const c = L.children(buf, t);
    if (t.tag === 0xa3) out.push({ kind: 'eq', attr: L.text(buf, c[0]), value: L.text(buf, c[1]) });
    else if (t.tag === 0xa9) out.push({ kind: 'inChain', rule: L.text(buf, c[0]), attr: L.text(buf, c[1]), value: L.text(buf, c[2]) });
    return out;
  }
  const server = tls.createServer({ cert, key }, rawSock => {
    seen.connections++;
    const sock = { write: b => rawSock.write(adStyle(b)), end: () => rawSock.end(), on: (e, f) => rawSock.on(e, f) };
    let buf = Buffer.alloc(0), bound = null;
    sock.on('error', () => {});
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const t = L.readTlv(buf, 0);
        if (!t) break;
        const [idT, op] = L.children(buf, t);
        const id = L.num(buf, idT);
        if (op.tag === 0x60) {
          const [, nameT, pwT] = L.children(buf, op);
          const name = L.text(buf, nameT), pw = L.text(buf, pwT);
          seen.binds.push(name);
          const sam = name.replace(/@pmcne\.ph$/i, '');
          const p = people[sam];
          if (p && p.password === pw && !p.sub) { bound = sam; sock.write(done(id, 0x61, 0)); }
          else sock.write(done(id, 0x61, 49, '80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data ' + ((p && p.password === pw && p.sub) || (p ? '52e' : '525')) + ', v4563'));
        } else if (op.tag === 0x63) {
          seen.searches++;
          if (!bound) { sock.write(done(id, 0x65, 1, '000004DC: LdapErr: DSID-0C090A5C, comment: In order to perform this operation a successful bind must be completed')); }
          else {
            const f = leaves(buf, L.children(buf, op)[6], []);
            const get = a => (f.find(x => x.kind === 'eq' && x.attr === a) || {}).value;
            if (get('objectClass') === 'group' && get('cn') === 'PMO Team') sock.write(entry(id, GROUP_DN, { distinguishedName: GROUP_DN }));
            const chain = f.find(x => x.kind === 'inChain');
            const sam = get('sAMAccountName');
            if (sam && chain && chain.rule === '1.2.840.113556.1.4.1941' && chain.value === GROUP_DN && people[sam] && people[sam].groups.includes('PMO Team')) {
              sock.write(entry(id, 'CN=' + people[sam].name + ',OU=Staff,DC=pmcne,DC=ph', { sAMAccountName: sam, displayName: people[sam].name }));
            }
            sock.write(done(id, 0x65, 0));
          }
        } else if (op.tag === 0x42) { sock.end(); }
        buf = buf.subarray(t.next);
      }
    });
  });
  return { server, seen, GROUP_DN };
}

module.exports = { fakeDc, adStyle };
