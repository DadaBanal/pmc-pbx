'use strict';
const fs = require('fs');
const path = require('path');

// Loads <confDir>/config.json and fills every path the app uses. Nothing here reads a secret.
function loadConfig(confDir) {
  const file = path.join(confDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.confDir = confDir;
  cfg.outDir = cfg.outDir || process.env.PMC_PBX_OUT || '/var/lib/pmc-pbx/out';
  cfg.dataDir = cfg.dataDir || path.dirname(cfg.outDir);
  cfg.secretsDir = cfg.secretsDir || path.join(confDir, 'secrets');
  cfg.directoryFile = path.join(confDir, 'directory.json');
  cfg.usersFile = path.join(cfg.secretsDir, 'users.json');
  cfg.phoneUsersFile = path.join(confDir, 'phone-users.json');
  cfg.secretsFile = path.join(cfg.secretsDir, 'secrets.json');
  cfg.historyDir = path.join(cfg.dataDir, 'history');
  cfg.auditFile = path.join(cfg.dataDir, 'audit.jsonl');
  cfg.certFile = cfg.certFile || path.join(cfg.secretsDir, 'cert.pem');
  cfg.keyFile = cfg.keyFile || path.join(cfg.secretsDir, 'key.pem');
  cfg.listen = Object.assign({ host: '0.0.0.0', port: 443 }, cfg.listen || {});
  cfg.admin = Object.assign({ host: '127.0.0.1', port: 8443, sessionHours: 12 }, cfg.admin || {});
  // wsHost/wsPort: Asterisk's own HTTP server, loopback only (asterisk/conf/http.conf), where the browser phone's
  // signed-in WebSocket is passed through to
  cfg.asterisk = Object.assign({ command: ['/usr/sbin/asterisk'], timeoutMs: 15000, wsHost: '127.0.0.1', wsPort: 8088 }, cfg.asterisk || {});
  cfg.sipPort = cfg.sipPort || 5061;
  // phone users from Active Directory (optional). pin: the domain controller's LDAPS certificate, SHA-256, AA:BB:...
  if (cfg.ad) {
    cfg.ad = Object.assign({ dept: 'ICT', timeoutMs: 5000 }, cfg.ad);
    cfg.ad.groups = Array.isArray(cfg.ad.groups) ? cfg.ad.groups : (cfg.ad.groups ? [cfg.ad.groups] : []);
    for (const k of ['url', 'pin', 'baseDN', 'upnSuffix']) if (!cfg.ad[k]) throw new Error('config.json ad.' + k + ' is required when ad is set');
    if (!cfg.ad.groups.length) throw new Error('config.json ad.groups must name at least one group');
  }
  // Where the browser phone may be used from (Dada, 13 Oct 2026: "only enable it on the default network"). A list of
  // networks; when set, the phone site, the phone page, phone sign-in, /api/softphone and /ws answer no one else.
  if (cfg.phoneNetworks !== undefined) {
    if (!Array.isArray(cfg.phoneNetworks) || cfg.phoneNetworks.some(c => !/^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/.test(c))) throw new Error('config.json phoneNetworks must be a list like ["10.2.0.0/22"]');
  }
  // the phone site (optional): { host, port, name }, e.g. 10.2.0.11, 443, phone.pmcne.ph
  if (cfg.phoneSite) cfg.phoneSite = Object.assign({ port: 443 }, cfg.phoneSite);
  cfg.provUrl = cfg.provUrl || ('https://' + cfg.fqdn + '/prov/');
  cfg.banAfter = cfg.banAfter || 10;
  cfg.banWindowSec = cfg.banWindowSec || 600;
  cfg.banSec = cfg.banSec || 3600;
  return cfg;
}

module.exports = { loadConfig };
