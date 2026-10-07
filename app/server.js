#!/usr/bin/env node
'use strict';
/*
 * pmc-pbx server. Two HTTPS listeners in one process, same certificate:
 *
 *   PUBLIC  (cfg.listen, forwarded from the internet)
 *     GET /health                 JSON, no auth
 *     GET /prov/<mac>.cfg         basic auth: user = MAC, password = that MAC's provisioning secret
 *     GET /prov/phonebook.xml     basic auth with any known MAC
 *
 *   ADMIN   (cfg.admin, LAN only, never forwarded)
 *     the PMC Phones screen (app/public) and its JSON API under /api/
 *     named users with roles viewer < editor < admin, HMAC session cookie, CSRF header on every write
 *
 * Node 22, built-ins only. Run: PMC_PBX_CONF=/etc/pmc-pbx node server.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { loadConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const V = require('./lib/validate');
const G = require('./lib/generate');
const A = require('./lib/asterisk');
const auth = require('./lib/auth');
const H = require('./lib/httpx');

const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'pmcpbx';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function applyChanges(cfg, store, who) {
  const dir = V.normalizeDirectory(store.loadDirectory());
  const problems = V.validateDirectory(dir, cfg);
  if (problems.length) return { ok: false, problems };
  const secrets = store.loadSecrets();
  const created = G.ensureSecrets(dir, secrets);
  if (created) store.saveSecrets(secrets);
  const manifest = G.generate(cfg, dir, secrets, cfg.outDir);
  const reload = await A.reload(cfg);
  store.audit({ who, action: 'apply', version: dir.version,
    detail: 'version ' + dir.version + ', ' + manifest.phones + ' phones, ' + (reload.ok ? 'engine reloaded' : 'engine NOT reloaded: ' + (reload.error || 'see steps')) });
  return { ok: reload.ok, manifest, reload, secretsCreated: created, error: reload.ok ? null : (reload.error || 'engine reload failed') };
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
  const provBans = new H.BanList(cfg.banAfter, cfg.banWindowSec, cfg.banSec);
  const loginBans = new H.BanList(cfg.banAfter, cfg.banWindowSec, cfg.banSec);
  const startedAt = Date.now();

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
    let m = /^\/prov\/([0-9a-f]{12})\.cfg$/.exec(url);
    if (m) {
      if (!provAuthOk(req, m[1])) return deny();
      const file = path.join(cfg.outDir, 'phones', m[1] + '.cfg');
      if (!fs.existsSync(file)) return finish(404, 'text/plain', 'not found', url);
      return finish(200, 'text/plain', fs.readFileSync(file), url + ' mac=' + m[1]);
    }
    if (url === '/prov/phonebook.xml') {
      const creds = H.basicCreds(req);
      if (!creds || !/^[0-9a-f]{12}$/.test(creds.user) || !provAuthOk(req, creds.user)) return deny();
      const file = path.join(cfg.outDir, 'phones', 'phonebook.xml');
      if (!fs.existsSync(file)) return finish(404, 'text/plain', 'not found', url);
      return finish(200, 'text/xml', fs.readFileSync(file), url + ' mac=' + creds.user);
    }
    return finish(404, 'text/plain', 'not found', url);
  }

  // ------------------------------------------------------------ admin listener
  const findExt = (dir, ext) => { const e = dir.extensions.find(x => x.ext === ext); if (!e) throw new HttpError(404, 'extension ' + ext + ' not found'); return e; };
  const check = dir => { const p = V.validateDirectory(dir, cfg); if (p.length) throw new HttpError(400, p.join('; ')); };
  const publicUser = u => ({ name: u.name, role: u.role, createdAt: u.createdAt, passwordAt: u.passwordAt, disabled: !!u.disabled });

  const routes = [
    ['GET', /^\/api\/me$/, 'viewer', ctx => ({ name: ctx.user.name, role: ctx.user.role })],
    ['POST', /^\/api\/logout$/, 'viewer', ctx => { ctx.res.setHeader('Set-Cookie', H.cookie(COOKIE, '', 0)); return { ok: true }; }],
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
      return { ext: e.ext, mac: e.mac || null, url: cfg.provUrl, username: e.mac || null, password: e.mac ? (s.prov[e.mac] || null) : null, sipPassword: s.sip[e.ext] || null, applied: !!(e.mac && fs.existsSync(path.join(cfg.outDir, 'phones', e.mac + '.cfg'))) };
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
    ['GET', /^\/api\/audit$/, 'admin', ctx => store.readAudit(Math.min(1000, Number(ctx.url.searchParams.get('limit')) || 200))],
    ['GET', /^\/api\/users$/, 'admin', () => auth.loadUsers(cfg.usersFile).users.map(publicUser)],
    ['POST', /^\/api\/users$/, 'admin', async ctx => {
      const body = await ctx.body();
      const data = auth.loadUsers(cfg.usersFile);
      const name = String(body.name || '').trim().toLowerCase();
      if (data.users.some(u => u.name === name)) throw new HttpError(409, 'user ' + name + ' already exists');
      try { auth.setPassword(data, name, body.password, body.role || 'viewer', ctx.user.name); } catch (e) { throw new HttpError(400, e.message); }
      auth.saveUsers(cfg.usersFile, data);
      store.audit({ who: ctx.user.name, action: 'add user', detail: name + ' as ' + (body.role || 'viewer') });
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
      auth.saveUsers(cfg.usersFile, data);
      store.audit({ who: ctx.user.name, action: 'edit user', detail: u.name + ': ' + (changes.join(', ') || 'no change') });
      return { ok: true };
    }],
    ['POST', /^\/api\/password$/, 'viewer', async ctx => {
      const body = await ctx.body();
      const data = auth.loadUsers(cfg.usersFile);
      const u = data.users.find(x => x.name === ctx.user.name);
      if (!u || !auth.verifyPassword(u, String(body.current || ''))) throw new HttpError(401, 'current password is wrong');
      try { auth.setPassword(data, u.name, body.next, null, u.name); } catch (e) { throw new HttpError(400, e.message); }
      auth.saveUsers(cfg.usersFile, data);
      store.audit({ who: u.name, action: 'change own password', detail: '' });
      return { ok: true };
    }]
  ];

  async function admin(req, res) {
    const ip = req.socket.remoteAddress || '?';
    const url = new URL(req.url || '/', 'https://admin.local');
    const p = url.pathname;
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET') return H.sendJson(res, 405, { error: 'method not allowed' });
      return H.serveStatic(res, PUBLIC_DIR, p === '/' ? '/index.html' : p);
    }
    if (req.method !== 'GET' && req.headers['x-pmc-pbx'] !== '1') return H.sendJson(res, 403, { error: 'missing X-PMC-PBX header' });

    if (p === '/api/login' && req.method === 'POST') {
      if (loginBans.isBanned(ip)) return H.sendJson(res, 429, { error: 'too many failed sign-ins, try again later' });
      let body; try { body = await H.readJson(req); } catch (e) { return H.sendJson(res, 400, { error: e.message }); }
      const name = String(body.name || '').trim().toLowerCase();
      const user = auth.loadUsers(cfg.usersFile).users.find(u => u.name === name);
      if (!user || user.disabled || !auth.verifyPassword(user, String(body.password || ''))) {
        loginBans.fail(ip); log('admin ' + ip + ' login FAILED for ' + (name || '?'));
        return H.sendJson(res, 401, { error: 'wrong name or password' });
      }
      loginBans.clear(ip);
      res.setHeader('Set-Cookie', H.cookie(COOKIE, auth.makeToken(getSecrets().session, user.name, cfg.admin.sessionHours), cfg.admin.sessionHours * 3600));
      store.audit({ who: user.name, action: 'sign in', detail: 'from ' + ip });
      log('admin ' + ip + ' login ' + user.name);
      return H.sendJson(res, 200, { name: user.name, role: user.role });
    }

    const session = auth.readToken(getSecrets().session, H.parseCookies(req)[COOKIE]);
    const user = session ? auth.loadUsers(cfg.usersFile).users.find(u => u.name === session.name) : null;
    if (!user || user.disabled) return H.sendJson(res, 401, { error: 'sign in' });

    for (const [method, re, minRole, handler] of routes) {
      const m = re.exec(p);
      if (!m || method !== req.method) continue;
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

  const publicServer = https.createServer(tls, provisioning);
  const adminServer = https.createServer(tls, (req, res) => {
    admin(req, res).catch(err => { log('ERROR ' + (err && err.stack || err)); if (!res.headersSent) H.sendJson(res, 500, { error: 'server error' }); });
  });
  publicServer.listen(cfg.listen.port, cfg.listen.host, () => log('provisioning listener on ' + cfg.listen.host + ':' + publicServer.address().port + ' for ' + cfg.fqdn + ', certificate valid to ' + certInfo.validTo));
  adminServer.listen(cfg.admin.port, cfg.admin.host, () => log('admin screen on https://' + cfg.admin.host + ':' + adminServer.address().port + '/'));

  return {
    publicServer, adminServer, store,
    close() {
      for (const s of [publicServer, adminServer]) { if (s.closeAllConnections) s.closeAllConnections(); s.close(); }
    }
  };
}

if (require.main === module) {
  const cfg = loadConfig(process.env.PMC_PBX_CONF || '/etc/pmc-pbx');
  start(cfg);
}

module.exports = { start, applyChanges, HttpError };
