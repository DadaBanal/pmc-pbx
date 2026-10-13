'use strict';
// Test helpers: a throwaway config tree with a self-signed certificate, and an https client that accepts it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { loadConfig } = require('../lib/config');

function haveOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

function makeEnv(overrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcpbx-'));
  const conf = path.join(root, 'conf');
  const secrets = path.join(conf, 'secrets');
  const data = path.join(root, 'data');
  const out = path.join(data, 'out');
  fs.mkdirSync(secrets, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const sample = path.join(__dirname, '..', 'sample');
  const cfgJson = JSON.parse(fs.readFileSync(path.join(sample, 'config.json'), 'utf8'));
  Object.assign(cfgJson, {
    listen: { host: '127.0.0.1', port: 0 },
    admin: { host: '127.0.0.1', port: 0, sessionHours: 1 },
    asterisk: { command: [process.execPath, path.join(__dirname, 'fake-asterisk.js')], timeoutMs: 5000 },
    // engine and browser are the same machine in tests, so loopback media is right here, and only here
    webrtcMediaAddress: '127.0.0.1',
    certFile: path.join(secrets, 'cert.pem'),
    keyFile: path.join(secrets, 'key.pem'),
    outDir: out,
    dataDir: data
  }, overrides || {});
  fs.writeFileSync(path.join(conf, 'config.json'), JSON.stringify(cfgJson, null, 2));
  // the tests own their directory; app/sample/directory.json is a showcase and may change at any time
  fs.writeFileSync(path.join(conf, 'directory.json'), JSON.stringify(require('./fixture').directory(), null, 2));
  if (haveOpenssl()) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
      '-keyout', cfgJson.keyFile, '-out', cfgJson.certFile], { stdio: 'ignore' });
  }
  const cfg = loadConfig(conf);
  return { root, conf, cfg, cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* windows file locks */ } } };
}

function listening(server) {
  return server.listening ? Promise.resolve() : new Promise(resolve => server.once('listening', resolve));
}

// request(base, method, path, { body, cookie, auth, noCsrf }) -> { status, headers, text, json, cookie }
function request(base, method, p, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const headers = {};
    if (!o.noCsrf) headers['X-PMC-PBX'] = '1';
    if (o.cookie) headers.Cookie = o.cookie;
    if (o.auth) headers.Authorization = 'Basic ' + Buffer.from(o.auth).toString('base64');
    let payload = null;
    if (o.body !== undefined) { payload = JSON.stringify(o.body); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = https.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, rejectUnauthorized: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
        const sc = res.headers['set-cookie'];
        const cookie = sc && sc.length ? sc[0].split(';')[0] : null;
        resolve({ status: res.statusCode, headers: res.headers, text, json, cookie });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { haveOpenssl, makeEnv, listening, request };
