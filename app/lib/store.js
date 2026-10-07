'use strict';
// directory.json: load, validate-free save with version bump, history copies, audit trail. Secrets: load/save 0600.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, ensureDir, readJsonOr } = require('./fsx');
const crypto = require('crypto');

const HISTORY_KEEP = 50;

class Store {
  constructor(cfg) { this.cfg = cfg; }

  loadDirectory() {
    const d = readJsonOr(this.cfg.directoryFile, null) || { version: 0, site: 'PMC', departments: [], extensions: [] };
    d.version = Number.isInteger(d.version) ? d.version : 0;
    d.departments = Array.isArray(d.departments) ? d.departments : [];
    d.extensions = Array.isArray(d.extensions) ? d.extensions : [];
    return d;
  }

  saveDirectory(dir, who, action, detail) {
    dir.version = (dir.version || 0) + 1;
    dir.updatedAt = new Date().toISOString();
    dir.updatedBy = who;
    const json = JSON.stringify(dir, null, 2) + '\n';
    writeFileAtomic(this.cfg.directoryFile, json, 0o640);
    ensureDir(this.cfg.historyDir);
    const stamp = dir.updatedAt.replace(/[:.]/g, '-');
    fs.copyFileSync(this.cfg.directoryFile, path.join(this.cfg.historyDir, 'directory-v' + dir.version + '-' + stamp + '.json'));
    this.pruneHistory();
    this.audit({ who, action, detail, version: dir.version });
    return dir.version;
  }

  pruneHistory() {
    const files = fs.readdirSync(this.cfg.historyDir).filter(f => f.startsWith('directory-v')).sort();
    while (files.length > HISTORY_KEEP) fs.unlinkSync(path.join(this.cfg.historyDir, files.shift()));
  }

  audit(entry) {
    ensureDir(this.cfg.dataDir);
    fs.appendFileSync(this.cfg.auditFile, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n');
  }

  readAudit(limit) {
    if (!fs.existsSync(this.cfg.auditFile)) return [];
    const lines = fs.readFileSync(this.cfg.auditFile, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-(limit || 200)).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
  }

  loadSecrets() {
    const s = readJsonOr(this.cfg.secretsFile, {});
    s.sip = s.sip || {};
    s.prov = s.prov || {};
    if (!s.session) { s.session = crypto.randomBytes(32).toString('hex'); this.saveSecrets(s); }
    return s;
  }

  saveSecrets(s) {
    ensureDir(this.cfg.secretsDir);
    writeFileAtomic(this.cfg.secretsFile, JSON.stringify(s, null, 2) + '\n', 0o600);
  }

  loadManifest() { return readJsonOr(path.join(this.cfg.outDir, 'manifest.json'), null); }
}

module.exports = { Store };
