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
  // pictures a desk phone may show (Avaya backgrounds), and which handset shows which: { "<mac>": "<file>.jpg" }
  cfg.phoneImagesDir = cfg.phoneImagesDir || path.join(confDir, 'phone-images');
  // CA certificates handsets download and trust (Avaya TRUSTCERTS)
  cfg.phoneCertsDir = cfg.phoneCertsDir || path.join(confDir, 'phone-certs');
  if (cfg.panelExtensions !== undefined && !(Array.isArray(cfg.panelExtensions) && cfg.panelExtensions.every(x => /^\d{4}$/.test(String(x))))) throw new Error('config.json panelExtensions must be a list of extension numbers like ["6666","3903"]');
  if (cfg.avayaBackgroundAll !== undefined && !/^[A-Za-z0-9._-]{1,60}\.jpg$/.test(String(cfg.avayaBackgroundAll))) throw new Error('config.json avayaBackgroundAll must be a file name ending .jpg in phone-images');
  if (cfg.avayaBackgrounds !== undefined) {
    const ok = cfg.avayaBackgrounds && typeof cfg.avayaBackgrounds === 'object' && !Array.isArray(cfg.avayaBackgrounds) &&
      Object.entries(cfg.avayaBackgrounds).every(([m, f]) => /^[0-9a-f]{12}$/.test(m) && /^[A-Za-z0-9._-]{1,60}\.jpg$/.test(String(f)));
    if (!ok) throw new Error('config.json avayaBackgrounds must map a MAC (12 lower-case hex) to a file name ending .jpg, e.g. {"c81fead7b058": "pmo-support.jpg"}');
  }
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
    const okCidr = c => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d{1,2})$/.exec(c); return !!m && m.slice(1, 5).every(o => +o <= 255) && +m[5] <= 32; };
    if (!Array.isArray(cfg.phoneNetworks) || !cfg.phoneNetworks.every(okCidr)) throw new Error('config.json phoneNetworks must be a list like ["10.2.0.0/22"] (octets 0-255, prefix 0-32)');
  }
  // Networks that may fetch a provisioning file guarded 'lan' (Avaya's 46xxsettings.txt) without a password
  // (Dada, 15 Oct 2026: "yes to the network only"). Unset: no one may.
  if (cfg.provNetworks !== undefined) {
    const okCidr = c => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d{1,2})$/.exec(c); return !!m && m.slice(1, 5).every(o => +o <= 255) && +m[5] <= 32; };
    if (!Array.isArray(cfg.provNetworks) || !cfg.provNetworks.every(okCidr)) throw new Error('config.json provNetworks must be a list like ["10.2.0.0/22"] (octets 0-255, prefix 0-32)');
  }
  // the phone site (optional): { host, port, name }, e.g. 10.2.0.11, 443, phone.pmcne.ph
  if (cfg.phoneSite) {
    cfg.phoneSite = Object.assign({ port: 443 }, cfg.phoneSite);
    // without a host it would listen on every address, the 13 Oct start failure again (review 14 Oct 2026)
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(cfg.phoneSite.host || '') || cfg.phoneSite.host === '0.0.0.0') throw new Error('config.json phoneSite.host must be one IPv4 address of this machine (e.g. 10.2.0.11), not empty or 0.0.0.0');
    const port = Number(cfg.phoneSite.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('config.json phoneSite.port must be a port number');
    cfg.phoneSite.port = port;
    if (port && port === Number(cfg.admin.port) && (cfg.admin.host === cfg.phoneSite.host || cfg.admin.host === '0.0.0.0')) throw new Error('config.json: admin and phoneSite would hold the same address and port');
  }
  // 13 Oct 2026 on PMC-PBX01: listen.host 0.0.0.0 holds port 443 on EVERY address, so the phone site's own address
  // could not bind and the service failed to start. Two listeners on one port must each name their own address.
  if (cfg.phoneSite && cfg.phoneSite.port && cfg.phoneSite.port === cfg.listen.port &&
      (cfg.listen.host === '0.0.0.0' || cfg.phoneSite.host === '0.0.0.0' || cfg.listen.host === cfg.phoneSite.host)) {
    throw new Error('config.json: listen (' + cfg.listen.host + ':' + cfg.listen.port + ') and phoneSite (' + cfg.phoneSite.host + ':' + cfg.phoneSite.port +
      ') would hold the same port. Set listen.host to the provisioning address (e.g. 10.2.0.10) and phoneSite.host to its own (e.g. 10.2.0.11).');
  }
  cfg.provUrl = cfg.provUrl || ('https://' + cfg.fqdn + '/prov/');
  cfg.banAfter = cfg.banAfter || 10;
  cfg.banWindowSec = cfg.banWindowSec || 600;
  cfg.banSec = cfg.banSec || 3600;
  // sign-in limits. Per address: higher than provisioning, because a mobile carrier puts many people behind one
  // address. Per account: AD lockout is OFF on this domain (threshold 0, AD session 14 Oct 2026), so this limit is
  // the only thing between a guessed name and unlimited password tries.
  cfg.loginBanAfter = cfg.loginBanAfter || 20;
  if (cfg.relay) {
    // the call relay (lib/relay.js): the name phones reach it by, and how long one credential lasts
    cfg.relay = Object.assign({ ttlSeconds: 43200, transports: ['udp', 'tcp', 'tls'] }, cfg.relay);
    const tr = cfg.relay.transports;
    if (!Array.isArray(tr) || !tr.length || tr.some(x => !['udp', 'tcp', 'tls'].includes(x)) || new Set(tr).size !== tr.length) throw new Error('config.json relay.transports must list some of "udp", "tcp", "tls", each once');
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(cfg.relay.host || '')) throw new Error('config.json relay.host must be the relay\'s DNS name, e.g. relay.pmcne.ph');
    const ttl = Number(cfg.relay.ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < 600 || ttl > 86400) throw new Error('config.json relay.ttlSeconds must be a whole number from 600 to 86400');
    cfg.relay.ttlSeconds = ttl;
  }
  // emergency calls (*99<ext>): the departments and extensions allowed to make them. Default PMO ICT only, until
  // Dada names who else may ring a phone through its silent mode.
  cfg.emergency = Object.assign({ departments: ['ICT'], extensions: [] }, cfg.emergency || {});
  if (!Array.isArray(cfg.emergency.departments) || !Array.isArray(cfg.emergency.extensions) ||
      cfg.emergency.extensions.some(x => !/^\d{3,6}$/.test(String(x)))) throw new Error('config.json emergency must be { "departments": [names], "extensions": ["3903", ...] }');
  // 0 switches the per-name pause off (config.json "accountBanAfter": 0); the per-address limit stays
  cfg.accountBanAfter = cfg.accountBanAfter === 0 ? 0 : (cfg.accountBanAfter || 5);
  cfg.accountBanWindowSec = cfg.accountBanWindowSec || 900;
  cfg.accountBanSec = cfg.accountBanSec || 900;
  return cfg;
}

module.exports = { loadConfig };
