#!/usr/bin/env node
'use strict';
/*
 * pmc-pbx server. Two HTTPS listeners in one process, same certificate:
 *
 *   PUBLIC  (cfg.listen, forwarded from the internet)
 *     GET /health                 JSON, no auth
 *     GET /prov/<file>            any file a phone driver generated. index.json beside them says how each is
 *                                 guarded: 'per-mac' wants that handset's own password, 'shared' any known MAC
 *
 *   ADMIN   (cfg.admin, LAN only, never forwarded)
 *     the PMC Phones screen (app/public) and its JSON API under /api/
 *     named users with roles phone < viewer < editor < admin, HMAC session cookie, CSRF header on every write
 *     /phone        the browser phone, for a user linked to one extension (role phone or above)
 *     /ws           WebSocket upgrade for that phone: same-origin, signed in, linked to an extension; passed
 *                   through to Asterisk's loopback-only HTTP server. Nothing else can reach the engine's /ws
 *   phone site      `phoneSite` (optional, e.g. 10.2.0.11:443 as https://phone.pmcne.ph): the browser phone only,
 *                   no port in the address. Same handler, but only the phone's files and the phone's API answer
 *
 * Phone users (`ad` in config.json): anyone who is not an admin-screen account signs in with their Active Directory
 * name and password, checked by binding to the domain controller; they must be in one of `ad.groups` (nested
 * membership counts). They are kept in their own list, phone-users.json, and get a browser phone on first sign-in.
 *
 * Node 22, built-ins only. Run: PMC_PBX_CONF=/etc/pmc-pbx node server.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const { loadConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const V = require('./lib/validate');
const G = require('./lib/generate');
const A = require('./lib/asterisk');
const auth = require('./lib/auth');
const H = require('./lib/httpx');
const phones = require('./lib/phones');
const { readJsonOr } = require('./lib/fsx');
const ldap = require('./lib/ldap');
const PU = require('./lib/phoneusers');
const RELAY = require('./lib/relay');

const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'pmcpbx';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function applyChanges(cfg, store, who) {
  const dir = V.normalizeDirectory(store.loadDirectory());
  const problems = V.validateDirectory(dir, cfg);
  if (problems.length) return { ok: false, problems };
  const secrets = store.loadSecrets();
  const created = G.ensureSecrets(dir, secrets) + RELAY.ensureSecret(cfg, secrets);
  if (created) store.saveSecrets(secrets);
  const manifest = G.generate(cfg, dir, secrets, cfg.outDir);
  const reload = await A.reload(cfg);
  let error = reload.ok ? null : (reload.error || 'engine reload failed');
  let verified = null;
  if (reload.ok) {
    // A reload that cannot read the new file says nothing and keeps the old config. Check what the engine holds.
    const st = await A.status(cfg);
    const dp = await A.run(cfg, 'dialplan show pmc-internal');
    const loaded = new Set(st.endpoints.map(p => p.ext));
    const missingEndpoints = dir.extensions.filter(e => !loaded.has(e.ext)).map(e => e.ext);
    const missingHints = dir.extensions.filter(e => !dp.stdout.includes("'" + e.ext + "' =>")).map(e => e.ext);
    verified = { endpoints: dir.extensions.length - missingEndpoints.length, hints: dir.extensions.length - missingHints.length, missingEndpoints, missingHints };
    if (st.engine !== 'ok') error = 'engine unreachable after reload: ' + (st.error || '');
    else if (missingEndpoints.length || missingHints.length) {
      error = 'engine reloaded but did not load ' + (missingEndpoints.length ? missingEndpoints.length + ' extension(s) [' + missingEndpoints.slice(0, 5).join(', ') + (missingEndpoints.length > 5 ? ', ...' : '') + ']' : '') +
        (missingEndpoints.length && missingHints.length ? ' and ' : '') + (missingHints.length ? missingHints.length + ' hint(s)' : '') +
        '. Check that the engine can read ' + cfg.outDir + '/asterisk (group and mode) and its log for config errors.';
    }
  }
  store.audit({ who, action: 'apply', version: dir.version,
    detail: 'version ' + dir.version + ', ' + manifest.phones + ' phones, ' + (error ? 'FAILED: ' + error : 'engine reloaded and verified (' + verified.endpoints + ' extensions, ' + verified.hints + ' hints)') });
  return { ok: !error, manifest, reload, verified, secretsCreated: created, error };
}

function start(cfg, opts) {
  opts = opts || {};
  const log = opts.log || (s => console.log(new Date().toISOString() + ' ' + s));
  const store = new Store(cfg);
  // secrets.json is re-read whenever its size or mtime changes (Apply creates new secrets in this process or another)
  let secretsCache = { stamp: '', data: null };
  const getSecrets = () => {
    const st = fs.statSync(cfg.secretsFile, { throwIfNoEntry: false });
    const stamp = st ? st.size + ':' + st.mtimeMs : 'none';
    if (!secretsCache.data || secretsCache.stamp !== stamp) secretsCache = { stamp, data: store.loadSecrets() };
    return secretsCache.data;
  };
  getSecrets();
  const cert = fs.readFileSync(cfg.certFile);
  const key = fs.readFileSync(cfg.keyFile);
  const certInfo = new crypto.X509Certificate(cert);
  const tls = { cert, key, minVersion: 'TLSv1.2' };
  // Preview mode: the admin screen over plain HTTP, allowed on the loopback address only (laptop demo, browser
  // panes that refuse a self-signed certificate). Never for the public listener, never on a LAN address.
  const adminPlain = !!cfg.admin.insecureHttp && /^(127\.0\.0\.1|localhost|::1)$/.test(cfg.admin.host);
  if (cfg.admin.insecureHttp && !adminPlain) throw new Error('admin.insecureHttp is only allowed with admin.host 127.0.0.1, localhost or ::1');
  const provBans = new H.BanList(cfg.banAfter, cfg.banWindowSec, cfg.banSec);
  const loginBans = new H.BanList(cfg.loginBanAfter, cfg.banWindowSec, cfg.banSec);
  const accountBans = new H.BanList(cfg.accountBanAfter, cfg.accountBanWindowSec, cfg.accountBanSec);
  const startedAt = Date.now();

  // Who a session belongs to: an admin-screen account, or a phone user from Active Directory (token name "ad:<sam>").
  // Both are re-read on every request, so switching someone off takes effect at once.
  function identity(name) {
    if (name.startsWith('ad:')) {
      if (!cfg.ad) return null;
      const u = PU.find(PU.load(cfg), name.slice(3));
      return u && !u.disabled && u.ext ? { name: u.sam, display: u.name, role: 'phone', ext: u.ext, ad: true } : null;
    }
    const u = auth.loadUsers(cfg.usersFile).users.find(x => x.name === name);
    return u && !u.disabled ? u : null;
  }
  const sessionOf = req => auth.readToken(getSecrets().session, H.parseCookies(req)[COOKIE]);
  function sessionUser(req) { const s = sessionOf(req); return s ? identity(s.name) : null; }

  // Open browser-phone connections, by session name. Switching someone off, removing them, unlinking their phone or
  // removing their extension closes these at once; a sweep every 30 s closes any whose session is no longer valid
  // (expired, disabled elsewhere, phone changed). Review 14 Oct 2026: an open socket used to outlive all of those.
  const liveWs = new Set();
  function dropPhones(sessionName, why) {
    for (const w of liveWs) if (w.key === sessionName) { liveWs.delete(w); w.socket.destroy(); w.up.destroy(); log('ws ' + w.ip + ' ' + w.key + ' closed: ' + why); }
  }
  const sweep = setInterval(() => {
    for (const w of liveWs) {
      const u = w.exp > Date.now() ? identity(w.key) : null;
      if (!u || u.ext !== w.ext) { liveWs.delete(w); w.socket.destroy(); w.up.destroy(); log('ws ' + w.ip + ' ' + w.key + ' closed: session no longer valid'); }
    }
  }, 30000);
  if (sweep.unref) sweep.unref();
  // every local account or phone user that points at an extension
  function linksTo(ext) {
    const out = auth.loadUsers(cfg.usersFile).users.filter(u => u.ext === ext).map(u => u.name);
    if (cfg.ad) for (const u of PU.load(cfg).users) if (u.ext === ext) out.push('phone user ' + u.sam);
    return out;
  }
  // what the phone site serves: the phone page and what it loads, nothing of the admin screen
  const PHONE_SITE_FILES = /^\/(phone|phone\.html|phone\.js|sip\.js|style\.css|manifest\.webmanifest|sw\.js|icons\/[a-z0-9-]+\.png)$/;
  const phoneFromOk = ip => !cfg.phoneNetworks || H.inNetworks(ip, cfg.phoneNetworks);
  const NOT_HERE = 'PMC Phone is not available on this network.';
  const AD_SAY = new Set(['account disabled', 'account locked out', 'password expired', 'password must be changed', 'account expired', 'not allowed at this time', 'not allowed from this computer']);

  const certDaysLeft = () => Math.floor((new Date(certInfo.validTo).getTime() - Date.now()) / 86400000);

  // ------------------------------------------------------------ public listener
  function health() {
    const m = store.loadManifest();
    return {
      ok: true, service: 'PMC PBX', fqdn: cfg.fqdn,
      phones: m ? m.phones : null, extensions: m ? m.extensions : null,
      appliedVersion: m ? m.directoryVersion : null, generatedAt: m ? m.generatedAt : null,
      certDaysLeft: certDaysLeft(), certValidTo: certInfo.validTo,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), bannedAddresses: provBans.count()
    };
  }

  function provAuthOk(req, mac) {
    const creds = H.basicCreds(req);
    const expected = getSecrets().prov[mac];
    if (!creds || !expected || creds.user !== mac) return false;
    const a = Buffer.from(creds.pass), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function provisioning(req, res) {
    const ip = req.socket.remoteAddress || '?';
    const url = (req.url || '/').split('?')[0];
    const finish = (status, type, body, what) => { H.sendText(res, status, type, body); log('prov ' + ip + ' ' + status + ' ' + what); };
    if (req.method !== 'GET') return finish(405, 'text/plain', 'method not allowed', url);
    if (url === '/health') return finish(200, 'application/json', JSON.stringify(health()) + '\n', url);
    if (provBans.isBanned(ip)) return finish(429, 'text/plain', 'too many failures', url);
    const deny = () => { provBans.fail(ip); res.setHeader('WWW-Authenticate', 'Basic realm="pmc-pbx"'); finish(401, 'text/plain', 'unauthorized', url); };
    // Every generated phone file is listed in index.json with the guard its driver asked for. A name that is
    // not in that index is never served, so no path can reach outside the phones folder.
    const m = /^\/prov\/([A-Za-z0-9._-]{1,64})$/.exec(url);
    if (m) {
      const name = m[1];
      const index = readJsonOr(path.join(cfg.outDir, 'phones', 'index.json'), {});
      const entry = index[name];
      if (!entry) return finish(404, 'text/plain', 'not found', url);
      const creds = H.basicCreds(req);
      if (entry.auth === 'per-mac') {
        // the file belongs to one handset: only that handset's own credentials open it
        if (entry.mac) { if (!provAuthOk(req, entry.mac)) return deny(); }
        else if (!creds || !/^[0-9a-f]{12}$/.test(creds.user) || !provAuthOk(req, creds.user)) return deny();
      } else if (entry.auth === 'shared') {
        // one file for every phone of that vendor; it carries no per-phone secret, but still never anonymous
        if (!creds || !/^[0-9a-f]{12}$/.test(creds.user) || !provAuthOk(req, creds.user)) return deny();
      } else {
        return finish(404, 'text/plain', 'not found', url);
      }
      const file = path.join(cfg.outDir, 'phones', name);
      if (!fs.existsSync(file)) return finish(404, 'text/plain', 'not found', url);
      return finish(200, entry.type || 'text/plain', fs.readFileSync(file),
        url + ' ' + entry.driver + (entry.mac ? ' mac=' + entry.mac : ' shared'));
    }
    return finish(404, 'text/plain', 'not found', url);
  }

  // ------------------------------------------------------------ admin listener
  const findExt = (dir, ext) => { const e = dir.extensions.find(x => x.ext === ext); if (!e) throw new HttpError(404, 'extension ' + ext + ' not found'); return e; };
  const check = dir => { const p = V.validateDirectory(dir, cfg); if (p.length) throw new HttpError(400, p.join('; ')); };
  const publicUser = u => ({ name: u.name, role: u.role, ext: u.ext || null, createdAt: u.createdAt, passwordAt: u.passwordAt, disabled: !!u.disabled });
  // a user's linked extension: four digits that exist in the directory, or empty to unlink
  const checkExt = ext => {
    if (ext === '' || ext === null) return null;
    const v = String(ext).trim();
    if (!/^\d{4}$/.test(v)) throw new HttpError(400, 'extension must be four digits');
    findExt(V.normalizeDirectory(store.loadDirectory()), v);
    return v;
  };

  const routes = [
    ['GET', /^\/api\/me$/, 'phone', ctx => ({ name: ctx.user.name, display: ctx.user.display || ctx.user.name, role: ctx.user.role, ext: ctx.user.ext || null, ad: !!ctx.user.ad })],
    ['POST', /^\/api\/logout$/, 'phone', ctx => { ctx.res.setHeader('Set-Cookie', H.cookie(COOKIE, '', 0, !adminPlain)); return { ok: true }; }],
    // The browser phone's own credentials: only ever the signed-in user's linked extension, never another
    ['GET', /^\/api\/softphone$/, 'phone', ctx => {
      if (!ctx.user.ext) throw new HttpError(404, 'No phone is linked to your sign-in yet. Ask PMO ICT to link your extension.');
      const dir = V.normalizeDirectory(store.loadDirectory());
      const e = dir.extensions.find(x => x.ext === ctx.user.ext);
      if (!e) throw new HttpError(404, 'Your extension ' + ctx.user.ext + ' is not in the phone directory. Ask PMO ICT.');
      const spec = phones.modelSpec(e.model);
      if (!spec || !spec.webrtc) throw new HttpError(409, 'Extension ' + e.ext + ' is set up for ' + (spec ? spec.label : e.model) + ', not the browser phone. Ask PMO ICT to change it.');
      const password = getSecrets().sip[e.ext];
      if (!password) throw new HttpError(409, 'Your phone ' + e.ext + ' is not switched on yet. PMO ICT will switch it on; try again later.');
      store.audit({ who: ctx.user.name, action: 'browser phone sign-in', detail: e.ext });
      return { ext: e.ext, name: e.name, dept: e.dept || '', password, domain: cfg.fqdn, wsPath: '/ws', iceServers: RELAY.iceServers(cfg, getSecrets().turn, e.ext) };
    }],
    // fresh relay credentials before a call, for a page that has been open longer than one lasts
    ['GET', /^\/api\/relay$/, 'phone', ctx => {
      if (!ctx.user.ext) throw new HttpError(404, 'No phone is linked to your sign-in yet.');
      return { iceServers: RELAY.iceServers(cfg, getSecrets().turn, ctx.user.ext) };
    }],
    ['GET', /^\/api\/phonebook$/, 'phone', () => {
      const dir = V.normalizeDirectory(store.loadDirectory());
      // a switched-off phone user is not someone to call
      const off = new Set(cfg.ad ? PU.load(cfg).users.filter(u => u.disabled).map(u => u.ext) : []);
      return { extensions: dir.extensions.filter(e => !off.has(e.ext)).map(e => ({ ext: e.ext, name: e.name, dept: e.dept || '' })), departments: dir.departments.map(x => x.name) };
    }],
    ['GET', /^\/api\/directory$/, 'viewer', () => V.normalizeDirectory(store.loadDirectory())],
    ['GET', /^\/api\/extensions\/next$/, 'editor', ctx => ({ ext: V.nextFreeExt(V.normalizeDirectory(store.loadDirectory()), ctx.url.searchParams.get('dept') || '') })],
    ['POST', /^\/api\/extensions$/, 'editor', async ctx => {
      const body = await ctx.body();
      const dir = V.normalizeDirectory(store.loadDirectory());
      const e = V.normalizeExtension(body);
      if (!e.ext) e.ext = V.nextFreeExt(dir, e.dept) || '';
      if (!e.ext) throw new HttpError(400, 'no free extension in that department');
      if (dir.extensions.some(x => x.ext === e.ext)) throw new HttpError(409, 'extension ' + e.ext + ' already exists');
      dir.extensions.push(e);
      check(dir);
      const version = store.saveDirectory(dir, ctx.user.name, 'add extension', e.ext + ' ' + e.name + (e.mac ? ' mac ' + e.mac : ''));
      return { ok: true, ext: e.ext, version };
    }],
    ['PUT', /^\/api\/extensions\/(\d{4})$/, 'editor', async ctx => {
      const body = await ctx.body();
      const dir = V.normalizeDirectory(store.loadDirectory());
      const cur = findExt(dir, ctx.params[0]);
      const e = V.normalizeExtension(Object.assign({}, cur, body, { ext: cur.ext }));
      dir.extensions[dir.extensions.indexOf(cur)] = e;
      check(dir);
      const version = store.saveDirectory(dir, ctx.user.name, 'edit extension', e.ext + ' ' + e.name);
      return { ok: true, ext: e.ext, version };
    }],
    ['DELETE', /^\/api\/extensions\/(\d{4})$/, 'editor', ctx => {
      const dir = V.normalizeDirectory(store.loadDirectory());
      const cur = findExt(dir, ctx.params[0]);
      // a sign-in still pointing at a removed number would inherit whoever gets that number next (review 14 Oct 2026)
      const linked = linksTo(cur.ext);
      if (linked.length) throw new HttpError(409, 'Extension ' + cur.ext + ' is the phone of ' + linked.join(', ') + '. Unlink it on the Users page first' + (cfg.ad ? ', or remove the phone user there' : '') + '.');
      dir.extensions = dir.extensions.filter(x => x !== cur);
      for (const x of dir.extensions) x.keys = x.keys.filter(k => k.ext !== cur.ext);
      check(dir);
      const version = store.saveDirectory(dir, ctx.user.name, 'remove extension', cur.ext + ' ' + cur.name);
      return { ok: true, version };
    }],
    ['GET', /^\/api\/extensions\/(\d{4})\/provisioning$/, 'admin', ctx => {
      const dir = V.normalizeDirectory(store.loadDirectory());
      const e = findExt(dir, ctx.params[0]);
      const s = store.loadSecrets();
      store.audit({ who: ctx.user.name, action: 'view phone secrets', detail: e.ext + (e.mac ? ' mac ' + e.mac : '') });
      const d = phones.driverFor(e.model);
      const spec = phones.modelSpec(e.model);
      const info = { ext: e.ext, mac: e.mac || null, model: e.model, vendor: spec ? spec.vendor : null,
        url: cfg.provUrl, fqdn: cfg.fqdn, sipPort: cfg.sipPort, adminPort: cfg.admin.port,
        provPassword: e.mac ? (s.prov[e.mac] || null) : null, sipPassword: s.sip[e.ext] || null };
      info.notes = d && d.setupNotes ? d.setupNotes(info) : [];
      // which generated file, if any, this handset fetches
      const idx = readJsonOr(path.join(cfg.outDir, 'phones', 'index.json'), {});
      info.files = Object.keys(idx).filter(n => idx[n].mac === e.mac || (idx[n].auth === 'shared' && idx[n].driver === (d && d.id)));
      info.applied = info.files.length > 0;
      // kept for the older screen fields
      info.username = e.mac || null; info.password = info.provPassword;
      return info;
    }],
    ['GET', /^\/api\/models$/, 'viewer', () => {
      const out = {};
      for (const id of phones.modelIds()) { const sp = phones.modelSpec(id); out[id] = { label: sp.label, vendor: sp.vendor, lineKeys: sp.lineKeys, blf: sp.blf }; }
      return out;
    }],
    ['GET', /^\/api\/departments$/, 'viewer', () => V.normalizeDirectory(store.loadDirectory()).departments],
    ['PUT', /^\/api\/departments$/, 'admin', async ctx => {
      const body = await ctx.body();
      const dir = V.normalizeDirectory(store.loadDirectory());
      dir.departments = (Array.isArray(body.departments) ? body.departments : []).map(V.normalizeDepartment).filter(d => d.name);
      check(dir);
      const version = store.saveDirectory(dir, ctx.user.name, 'edit departments', dir.departments.map(d => d.name + ' ' + d.from + '-' + d.to).join(', '));
      return { ok: true, version };
    }],
    ['POST', /^\/api\/apply$/, 'editor', async ctx => {
      const r = await applyChanges(cfg, store, ctx.user.name);
      if (!r.ok) return Object.assign({ _status: r.problems ? 400 : 502 }, r);
      return r;
    }],
    ['GET', /^\/api\/status$/, 'viewer', async () => {
      const dir = V.normalizeDirectory(store.loadDirectory());
      const manifest = store.loadManifest();
      const engine = await A.status(cfg);
      const byExt = new Map(dir.extensions.map(e => [e.ext, e]));
      const contacts = new Map(engine.contacts.map(c => [c.ext, c]));
      const endpoints = engine.endpoints.map(p => {
        const e = byExt.get(p.ext) || {}; const c = contacts.get(p.ext);
        return { ext: p.ext, name: e.name || null, dept: e.dept || null, state: p.state, registered: !!(c && c.status === 'Avail'), host: c ? c.host : null, rtt: c ? c.rtt : null };
      });
      return {
        engine: { state: engine.engine, version: engine.version, error: engine.error || null, activeCalls: engine.activeCalls },
        endpoints, registered: endpoints.filter(x => x.registered).length,
        directoryVersion: dir.version, appliedVersion: manifest ? manifest.directoryVersion : null,
        pending: !manifest || manifest.directoryVersion !== dir.version,
        appliedAt: manifest ? manifest.generatedAt : null,
        certDaysLeft: certDaysLeft(), uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
      };
    }],
    // the phone users list (Active Directory sign-ins), separate from the admin screen's own accounts
    ['GET', /^\/api\/phone-users$/, 'admin', () => ({ ad: cfg.ad ? { groups: cfg.ad.groups, dept: cfg.ad.dept, url: cfg.ad.url } : null, users: PU.load(cfg).users })],
    ['PUT', /^\/api\/phone-users\/([a-z0-9._-]+)$/, 'admin', async ctx => {
      const body = await ctx.body();
      if (body.disabled === undefined) throw new HttpError(400, 'nothing to change');
      // disabledBy 'admin': the group sync never switches back on someone PMO ICT switched off by hand
      const u = PU.update(cfg, ctx.params[0], { disabled: !!body.disabled, disabledBy: body.disabled ? 'admin' : null });
      if (!u) throw new HttpError(404, 'phone user not found');
      if (u.disabled) dropPhones('ad:' + u.sam, 'switched off');
      store.audit({ who: ctx.user.name, action: 'edit phone user', detail: u.sam + ': ' + (u.disabled ? 'switched off' : 'switched on') });
      return { ok: true };
    }],
    ['DELETE', /^\/api\/phone-users\/([a-z0-9._-]+)$/, 'admin', ctx => {
      const r = PU.remove(cfg, store, ctx.params[0], ctx.user.name);
      if (!r) throw new HttpError(404, 'phone user not found');
      dropPhones('ad:' + r.user.sam, 'removed');
      return { ok: true, ext: r.ext };
    }],
    ['GET', /^\/api\/audit$/, 'admin', ctx => store.readAudit(Math.min(1000, Number(ctx.url.searchParams.get('limit')) || 200))],
    ['GET', /^\/api\/users$/, 'admin', () => auth.loadUsers(cfg.usersFile).users.map(publicUser)],
    ['POST', /^\/api\/users$/, 'admin', async ctx => {
      const body = await ctx.body();
      const data = auth.loadUsers(cfg.usersFile);
      const name = String(body.name || '').trim().toLowerCase();
      if (data.users.some(u => u.name === name)) throw new HttpError(409, 'user ' + name + ' already exists');
      const ext = body.ext ? checkExt(body.ext) : null;
      try { auth.setPassword(data, name, body.password, body.role || 'viewer', ctx.user.name); } catch (e) { throw new HttpError(400, e.message); }
      if (ext) data.users.find(u => u.name === name).ext = ext;
      auth.saveUsers(cfg.usersFile, data);
      store.audit({ who: ctx.user.name, action: 'add user', detail: name + ' as ' + (body.role || 'viewer') + (ext ? ', phone ' + ext : '') });
      return { ok: true };
    }],
    ['PUT', /^\/api\/users\/([a-z0-9._-]+)$/, 'admin', async ctx => {
      const body = await ctx.body();
      const data = auth.loadUsers(cfg.usersFile);
      const u = data.users.find(x => x.name === ctx.params[0]);
      if (!u) throw new HttpError(404, 'user not found');
      const self = u.name === ctx.user.name;
      const changes = [];
      if (body.role && body.role !== u.role) { if (self) throw new HttpError(400, 'you cannot change your own role'); if (!auth.ROLES[body.role]) throw new HttpError(400, 'bad role'); u.role = body.role; changes.push('role ' + body.role); }
      if (body.disabled !== undefined && !!body.disabled !== !!u.disabled) { if (self) throw new HttpError(400, 'you cannot disable yourself'); u.disabled = !!body.disabled; changes.push(u.disabled ? 'disabled' : 'enabled'); }
      if (body.password) { try { auth.setPassword(data, u.name, body.password, null, ctx.user.name); } catch (e) { throw new HttpError(400, e.message); } changes.push('password reset'); }
      if (body.ext !== undefined) { const ext = checkExt(body.ext); if ((ext || null) !== (u.ext || null)) { if (ext) u.ext = ext; else delete u.ext; changes.push(ext ? 'phone ' + ext : 'phone unlinked'); } }
      auth.saveUsers(cfg.usersFile, data);
      if (u.disabled || changes.some(c => /^phone /.test(c))) dropPhones(u.name, changes.join(', '));
      store.audit({ who: ctx.user.name, action: 'edit user', detail: u.name + ': ' + (changes.join(', ') || 'no change') });
      return { ok: true };
    }],
    ['POST', /^\/api\/password$/, 'phone', async ctx => {
      const body = await ctx.body();
      if (ctx.user.ad) throw new HttpError(400, 'Your password is your Windows password. Change it in Windows (Ctrl+Alt+Del).');
      const data = auth.loadUsers(cfg.usersFile);
      const u = data.users.find(x => x.name === ctx.user.name);
      if (!u || !auth.verifyPassword(u, String(body.current || ''))) throw new HttpError(401, 'current password is wrong');
      try { auth.setPassword(data, u.name, body.next, null, u.name); } catch (e) { throw new HttpError(400, e.message); }
      auth.saveUsers(cfg.usersFile, data);
      store.audit({ who: u.name, action: 'change own password', detail: '' });
      return { ok: true };
    }]
  ];

  async function admin(req, res, site) {
    const ip = req.socket.remoteAddress || '?';
    const url = new URL(req.url || '/', 'https://admin.local');
    const p = url.pathname;
    if (!adminPlain) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    // decoded and normalised before any check, so %2Fphone.html and friends are judged as what they will serve
    let np = p; try { np = path.posix.normalize(decodeURIComponent(p)); } catch (e) { return H.sendText(res, 400, 'text/plain', 'bad path'); }
    // the browser phone answers only the networks it is enabled on (when phoneNetworks is set); the admin screen is not affected
    if (!phoneFromOk(ip) && (site === 'phone' || np === '/phone' || np === '/phone.html' || np === '/api/softphone' || np === '/api/phonebook' || np === '/api/relay')) {
      log('phone ' + ip + ' refused: not on an enabled network (' + p + ')');
      return p.startsWith('/api/') ? H.sendJson(res, 403, { error: NOT_HERE }) : H.sendText(res, 403, 'text/plain; charset=utf-8', NOT_HERE);
    }
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET') return H.sendJson(res, 405, { error: 'method not allowed' });
      if (site === 'phone') {
        if (p === '/') { res.writeHead(302, { Location: '/phone' }); return res.end(); }
        if (!PHONE_SITE_FILES.test(p)) return H.sendText(res, 404, 'text/plain', 'not found');
      }
      return H.serveStatic(res, PUBLIC_DIR, p === '/' ? '/index.html' : p === '/phone' ? '/phone.html' : p);
    }
    if (req.method !== 'GET' && req.headers['x-pmc-pbx'] !== '1') return H.sendJson(res, 403, { error: 'missing X-PMC-PBX header' });

    if (p === '/api/login' && req.method === 'POST') {
      if (loginBans.isBanned(ip)) return H.sendJson(res, 429, { error: 'too many failed sign-ins, try again later' });
      let body; try { body = await H.readJson(req); } catch (e) { return H.sendJson(res, 400, { error: e.message }); }
      const name = String(body.name || '').trim().toLowerCase();
      // per account as well as per address, and a success never wipes the address's count (review 14 Oct 2026)
      const acct = 'acct:' + ((cfg.ad && ldap.accountName(name, cfg.ad.upnSuffix)) || name);
      if (accountBans.isBanned(acct)) { log('login ' + ip + ' refused for ' + (name || '?') + ': account cooling down'); return H.sendJson(res, 429, { error: 'too many failed sign-ins for this name, try again in 15 minutes' }); }
      const fail = why => { loginBans.fail(ip); accountBans.fail(acct); log('login ' + ip + ' FAILED for ' + (name || '?') + (why ? ': ' + why : '')); };
      let user = auth.loadUsers(cfg.usersFile).users.find(u => u.name === name);
      // the phone site, reachable from the internet, never checks an admin-screen password
      if (user && site === 'phone' && user.role !== 'phone') { fail('admin-screen account on the phone site'); return H.sendJson(res, 401, { error: 'wrong name or password' }); }
      if (!user && cfg.ad) {
        if (!phoneFromOk(ip)) { log('phone ' + ip + ' AD sign-in refused: not on an enabled network'); return H.sendJson(res, 403, { error: NOT_HERE }); }
        return adLogin(req, res, ip, name, String(body.password || ''), acct, fail);
      }
      if (!user || user.disabled || !auth.verifyPassword(user, String(body.password || ''))) {
        fail();
        return H.sendJson(res, 401, { error: 'wrong name or password' });
      }
      accountBans.clear(acct);
      res.setHeader('Set-Cookie', H.cookie(COOKIE, auth.makeToken(getSecrets().session, user.name, cfg.admin.sessionHours), cfg.admin.sessionHours * 3600, !adminPlain));
      store.audit({ who: user.name, action: 'sign in', detail: 'from ' + ip });
      log('admin ' + ip + ' login ' + user.name);
      return H.sendJson(res, 200, { name: user.name, role: user.role });
    }

    const user = sessionUser(req);
    if (!user) return H.sendJson(res, 401, { error: 'sign in' });

    for (const [method, re, minRole, handler] of routes) {
      const m = re.exec(p);
      if (!m || method !== req.method) continue;
      if (site === 'phone' && minRole !== 'phone') continue; // the phone site answers the phone's own API only
      if (!auth.roleAtLeast(user.role, minRole)) return H.sendJson(res, 403, { error: 'your role (' + user.role + ') cannot do this' });
      const ctx = { req, res, user, url, params: m.slice(1), body: () => H.readJson(req) };
      try {
        const out = await handler(ctx);
        const status = (out && out._status) || 200;
        if (out && out._status) delete out._status;
        return H.sendJson(res, status, out);
      } catch (err) {
        if (err instanceof HttpError) return H.sendJson(res, err.status, { error: err.message });
        if (err && /invalid JSON|body too large/.test(err.message)) return H.sendJson(res, 400, { error: err.message });
        throw err;
      }
    }
    return H.sendJson(res, 404, { error: 'no such API' });
  }

  // A domain account: password checked by binding to the domain controller, then group membership. On the first
  // sign-in the person is added to the phone users list with a browser phone, and the engine is reloaded.
  async function adLogin(req, res, ip, name, password, acct, fail) {
    const r = await ldap.checkPerson(cfg.ad, name, password);
    if (!r.ok) {
      // an outage does NOT count against the name: 14 Oct 2026 an outage (our own parser fault) put staff in a 15-minute
      // cooldown for something that was not theirs; the per-address limit still applies
      if (r.unavailable) { loginBans.fail(ip); log('phone ' + ip + ' AD sign-in for ' + (name || '?') + ' UNAVAILABLE: ' + r.reason); return H.sendJson(res, 503, { error: 'The hospital directory did not answer. Try again in a minute.' }); }
      fail('AD: ' + r.reason);
      if (/^not in /.test(r.reason)) return H.sendJson(res, 403, { error: 'Your Windows account is not on the phone list. Ask PMO ICT.' });
      if (AD_SAY.has(r.reason)) return H.sendJson(res, 401, { error: 'Windows says: ' + r.reason + '.' });
      return H.sendJson(res, 401, { error: 'wrong name or password' });
    }
    accountBans.clear(acct);
    let pu = PU.find(PU.load(cfg), r.sam);
    if (pu && pu.disabled) { log('phone ' + ip + ' AD sign-in refused for ' + r.sam + ': switched off'); return H.sendJson(res, 403, { error: 'PMO ICT has switched off your phone. Ask them.' }); }
    if (!pu) {
      // apply only when nothing else is waiting: a phone user's first sign-in must never push an editor's
      // unapplied changes live (review 14 Oct 2026). Otherwise the new phone waits for PMO ICT's next Apply.
      const m = store.loadManifest(), before = V.normalizeDirectory(store.loadDirectory());
      const clean = !!m && m.directoryVersion === before.version;
      try { pu = PU.add(cfg, store, r.sam, r.name, r.group, 'ad:' + r.sam).user; } catch (e) { log('phone user ' + r.sam + ' NOT added: ' + e.message); return H.sendJson(res, 409, { error: 'Could not give you a phone: ' + e.message + '. Ask PMO ICT.' }); }
      if (clean) {
        const ap = await applyChanges(cfg, store, 'ad:' + r.sam);
        log('phone user ' + r.sam + ' added as ' + pu.ext + '; apply ' + (ap.ok ? 'ok' : 'FAILED: ' + (ap.error || (ap.problems || []).join('; '))));
      } else log('phone user ' + r.sam + ' added as ' + pu.ext + '; NOT applied: other changes are waiting for PMO ICT');
    }
    PU.update(cfg, r.sam, { lastSignIn: new Date().toISOString() });
    res.setHeader('Set-Cookie', H.cookie(COOKIE, auth.makeToken(getSecrets().session, 'ad:' + r.sam, cfg.admin.sessionHours), cfg.admin.sessionHours * 3600, !adminPlain));
    store.audit({ who: 'ad:' + r.sam, action: 'sign in', detail: 'phone ' + pu.ext + ' from ' + ip });
    log('phone ' + ip + ' AD sign-in ' + r.sam + ' phone ' + pu.ext);
    return H.sendJson(res, 200, { name: r.sam, display: pu.name, role: 'phone', ext: pu.ext });
  }

  // ------------------------------------------------------------ the browser phone's WebSocket
  // Refused unless it comes from this site's own page (Origin), with a live session, for a user linked to an
  // extension. Then the bytes are passed to Asterisk's loopback HTTP server untouched, minus the cookie.
  const CRLF = String.fromCharCode(13, 10);
  function wsProxy(req, socket, head) {
    const ip = req.socket.remoteAddress || '?';
    let done = false;
    const refuse = (status, why) => {
      if (done) return;
      done = true;
      try { socket.end('HTTP/1.1 ' + status + CRLF + 'Connection: close' + CRLF + 'Content-Length: 0' + CRLF + CRLF); } catch (e) { /* gone */ }
      log('ws ' + ip + ' refused ' + status.split(' ')[0] + ': ' + why);
    };
    socket.on('error', () => {});
    let url;
    try { url = new URL(req.url || '/', 'https://admin.local'); } catch (e) { return refuse('400 Bad Request', 'bad url'); }
    if (url.pathname !== '/ws') return refuse('404 Not Found', url.pathname);
    if (!phoneFromOk(ip)) return refuse('403 Forbidden', 'not on an enabled network');
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) return refuse('400 Bad Request', 'not a WebSocket upgrade');
    const origin = req.headers.origin || '';
    const host = req.headers.host || '';
    if (!origin || origin !== (adminPlain ? 'http://' : 'https://') + host) return refuse('403 Forbidden', 'origin ' + (origin || 'none') + ' is not this site');
    const session = sessionOf(req);
    const user = session ? identity(session.name) : null;
    if (!user) return refuse('401 Unauthorized', 'no session');
    if (!auth.roleAtLeast(user.role, 'phone') || !user.ext) return refuse('403 Forbidden', user.name + ' has no linked phone');
    const up = net.connect(cfg.asterisk.wsPort, cfg.asterisk.wsHost);
    up.on('error', e => { if (!done) refuse('502 Bad Gateway', 'engine: ' + e.message); else socket.destroy(); });
    up.once('connect', () => {
      if (done) { up.destroy(); return; }
      done = true;
      const lines = ['GET /ws HTTP/1.1', 'Host: ' + cfg.asterisk.wsHost + ':' + cfg.asterisk.wsPort, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + req.headers['sec-websocket-key'], 'Sec-WebSocket-Version: ' + (req.headers['sec-websocket-version'] || '13')];
      if (req.headers['sec-websocket-protocol']) lines.push('Sec-WebSocket-Protocol: ' + req.headers['sec-websocket-protocol']);
      up.write(lines.join(CRLF) + CRLF + CRLF);
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
      const live = { key: session.name, ext: user.ext, exp: session.exp, ip, socket, up };
      liveWs.add(live);
      up.on('close', () => { liveWs.delete(live); socket.destroy(); });
      socket.on('close', () => { liveWs.delete(live); up.destroy(); });
      log('ws ' + ip + ' ' + user.name + ' phone ' + user.ext + ' connected');
    });
  }

  const publicServer = https.createServer(tls, provisioning);
  const adminHandler = (req, res) => {
    admin(req, res).catch(err => { log('ERROR ' + (err && err.stack || err)); if (!res.headersSent) H.sendJson(res, 500, { error: 'server error' }); });
  };
  const adminServer = adminPlain ? http.createServer(adminHandler) : https.createServer(tls, adminHandler);
  adminServer.on('upgrade', wsProxy);
  // the public listener never upgrades: phones fetch files there, nothing more
  publicServer.on('upgrade', (req, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 404 Not Found' + CRLF + 'Connection: close' + CRLF + 'Content-Length: 0' + CRLF + CRLF); });
  publicServer.listen(cfg.listen.port, cfg.listen.host, () => log('provisioning listener on ' + cfg.listen.host + ':' + publicServer.address().port + ' for ' + cfg.fqdn + ', certificate valid to ' + certInfo.validTo));
  // the phone site: the browser phone at an address with no port in it (phone.pmcne.ph on its own LAN address)
  let phoneServer = null;
  if (cfg.phoneSite) {
    phoneServer = https.createServer(tls, (req, res) => {
      admin(req, res, 'phone').catch(err => { log('ERROR ' + (err && err.stack || err)); if (!res.headersSent) H.sendJson(res, 500, { error: 'server error' }); });
    });
    phoneServer.on('upgrade', wsProxy);
    phoneServer.listen(cfg.phoneSite.port, cfg.phoneSite.host, () => log('phone site on ' + cfg.phoneSite.host + ':' + phoneServer.address().port + (cfg.phoneSite.name ? ' as https://' + cfg.phoneSite.name + '/' : '')));
  }
  adminServer.listen(cfg.admin.port, cfg.admin.host, () => log('admin screen on ' + (adminPlain ? 'http' : 'https') + '://' + cfg.admin.host + ':' + adminServer.address().port + '/' + (adminPlain ? '  (PREVIEW MODE, plain HTTP on loopback only)' : '')));

  return {
    publicServer, adminServer, phoneServer, store,
    close() {
      clearInterval(sweep);
      for (const w of liveWs) { w.socket.destroy(); w.up.destroy(); }
      for (const s of [publicServer, adminServer, phoneServer].filter(Boolean)) { if (s.closeAllConnections) s.closeAllConnections(); s.close(); }
    }
  };
}

if (require.main === module) {
  const cfg = loadConfig(process.env.PMC_PBX_CONF || '/etc/pmc-pbx');
  start(cfg);
}

module.exports = { start, applyChanges, HttpError };
