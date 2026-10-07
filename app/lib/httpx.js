'use strict';
// Small HTTP helpers: JSON in and out, cookies, basic auth, safe static files, a failure ban list.
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, type, body, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > (limit || 262144)) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach(part => { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); });
  return out;
}

function cookie(name, value, maxAgeSec) {
  return name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; Secure; SameSite=Strict' + (maxAgeSec != null ? '; Max-Age=' + maxAgeSec : '');
}

function basicCreds(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i).toLowerCase(), pass: decoded.slice(i + 1) };
}

function serveStatic(res, rootDir, urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(rootDir, clean);
  if (!file.startsWith(rootDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendText(res, 404, 'text/plain', 'not found');
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

class BanList {
  constructor(after, windowSec, banSec) { this.after = after; this.windowMs = windowSec * 1000; this.banMs = banSec * 1000; this.map = new Map(); }
  isBanned(ip) { const f = this.map.get(ip); return !!(f && f.bannedUntil > Date.now()); }
  fail(ip) {
    const now = Date.now();
    let f = this.map.get(ip);
    if (!f || now - f.first > this.windowMs) f = { count: 0, first: now, bannedUntil: 0 };
    f.count++;
    if (f.count >= this.after) f.bannedUntil = now + this.banMs;
    this.map.set(ip, f);
    return f.bannedUntil > now;
  }
  clear(ip) { this.map.delete(ip); }
  count() { const now = Date.now(); let n = 0; for (const f of this.map.values()) if (f.bannedUntil > now) n++; return n; }
}

module.exports = { sendJson, sendText, readJson, parseCookies, cookie, basicCreds, serveStatic, BanList };
