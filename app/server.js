#!/usr/bin/env node
'use strict';
/*
 * pmc-pbx provisioning and health server. Node 22, built-ins only.
 *
 *   GET /health              JSON, no auth: ok, phones, directory version, certificate days left, uptime
 *   GET /prov/<mac>.cfg      HTTP basic auth, user = the MAC, password = that MAC's provisioning secret
 *   GET /prov/phonebook.xml  HTTP basic auth with any known MAC's credentials
 *   anything else            404
 *
 * Failed logins are counted per source address; after `banAfter` failures inside `banWindowSec`
 * the address gets 429 for `banSec`. Nothing secret is ever logged.
 *
 * Config: <conf>/config.json  { fqdn, listen: { host, port }, certFile, keyFile, outDir, banAfter, banWindowSec, banSec }
 * Run:    PMC_PBX_CONF=/etc/pmc-pbx node server.js     (the systemd unit sets this)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CONF = process.env.PMC_PBX_CONF || '/etc/pmc-pbx';
const config = JSON.parse(fs.readFileSync(path.join(CONF, 'config.json'), 'utf8'));
const OUT = config.outDir || process.env.PMC_PBX_OUT || '/var/lib/pmc-pbx/out';
const SECRETS_FILE = path.join(CONF, 'secrets', 'secrets.json');
const certFile = config.certFile || path.join(CONF, 'secrets', 'cert.pem');
const keyFile = config.keyFile || path.join(CONF, 'secrets', 'key.pem');
const listen = Object.assign({ host: '0.0.0.0', port: 443 }, config.listen || {});
const banAfter = config.banAfter || 10;
const banWindowMs = (config.banWindowSec || 600) * 1000;
const banMs = (config.banSec || 3600) * 1000;
const startedAt = Date.now();

const cert = fs.readFileSync(certFile);
const key = fs.readFileSync(keyFile);
const certInfo = new crypto.X509Certificate(cert);

let secrets = loadSecrets();
fs.watchFile(SECRETS_FILE, { interval: 5000 }, () => { secrets = loadSecrets(); log('secrets reloaded'); });

const failures = new Map(); // ip -> { count, first, bannedUntil }

const server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  const url = (req.url || '/').split('?')[0];

  if (req.method !== 'GET') return done(res, 405, 'text/plain', 'method not allowed', ip, url);
  if (url === '/health') return done(res, 200, 'application/json', JSON.stringify(health()) + '\n', ip, url);

  const banned = isBanned(ip);
  if (banned) return done(res, 429, 'text/plain', 'too many failures', ip, url);

  let m = /^\/prov\/([0-9a-f]{12})\.cfg$/.exec(url);
  if (m) {
    const mac = m[1];
    if (!authOk(req, mac, mac)) return deny(res, ip, url);
    const file = path.join(OUT, 'phones', mac + '.cfg');
    if (!fs.existsSync(file)) return done(res, 404, 'text/plain', 'not found', ip, url);
    return done(res, 200, 'text/plain', fs.readFileSync(file), ip, url + ' mac=' + mac);
  }

  if (url === '/prov/phonebook.xml') {
    const creds = basicCreds(req);
    if (!creds || !authOk(req, creds.user, creds.user)) return deny(res, ip, url);
    const file = path.join(OUT, 'phones', 'phonebook.xml');
    if (!fs.existsSync(file)) return done(res, 404, 'text/plain', 'not found', ip, url);
    return done(res, 200, 'text/xml', fs.readFileSync(file), ip, url + ' mac=' + creds.user);
  }

  return done(res, 404, 'text/plain', 'not found', ip, url);
});

server.listen(listen.port, listen.host, () => {
  log('pmc-pbx provisioning server listening on ' + listen.host + ':' + listen.port + ' for ' + config.fqdn +
    ', certificate valid to ' + certInfo.validTo);
});

// ------------------------------------------------------------------ helpers
function health() {
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')); } catch (e) { manifest = null; }
  const daysLeft = Math.floor((new Date(certInfo.validTo).getTime() - Date.now()) / 86400000);
  return {
    ok: true,
    service: 'PMC PBX provisioning',
    fqdn: config.fqdn,
    phones: manifest ? manifest.phones : null,
    extensions: manifest ? manifest.extensions : null,
    directoryVersion: manifest ? manifest.directoryVersion : null,
    generatedAt: manifest ? manifest.generatedAt : null,
    certDaysLeft: daysLeft,
    certValidTo: certInfo.validTo,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    bannedAddresses: [...failures.values()].filter(f => f.bannedUntil > Date.now()).length
  };
}

function loadSecrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); }
  catch (e) { log('WARNING cannot read secrets.json: ' + e.message); return { sip: {}, prov: {} }; }
}

function basicCreds(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i).toLowerCase(), pass: decoded.slice(i + 1) };
}

function authOk(req, expectedUser, mac) {
  const creds = basicCreds(req);
  if (!creds) return false;
  const expectedPass = (secrets.prov || {})[mac];
  if (!expectedPass || creds.user !== expectedUser) return false;
  const a = Buffer.from(creds.pass), b = Buffer.from(expectedPass);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isBanned(ip) {
  const f = failures.get(ip);
  return !!(f && f.bannedUntil && f.bannedUntil > Date.now());
}

function recordFailure(ip) {
  const now = Date.now();
  let f = failures.get(ip);
  if (!f || now - f.first > banWindowMs) f = { count: 0, first: now, bannedUntil: 0 };
  f.count++;
  if (f.count >= banAfter) { f.bannedUntil = now + banMs; log('BAN ' + ip + ' for ' + (banMs / 1000) + 's after ' + f.count + ' failures'); }
  failures.set(ip, f);
}

function deny(res, ip, url) {
  recordFailure(ip);
  res.setHeader('WWW-Authenticate', 'Basic realm="pmc-pbx"');
  return done(res, 401, 'text/plain', 'unauthorized', ip, url);
}

function done(res, status, type, body, ip, what) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
  log(ip + ' ' + status + ' ' + what);
}

function log(s) { console.log(new Date().toISOString() + ' ' + s); }
