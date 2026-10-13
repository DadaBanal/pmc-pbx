'use strict';
// The phone users list: people who sign in with their Active Directory account, kept apart from the admin screen's
// own accounts (Dada, 13 Oct 2026: "there should be a separate user list that is link to the ad add pmo team on it").
// Who may be on it is decided by AD group membership, checked at every sign-in. This file only remembers which
// extension each person has, when they last signed in, and whether PMO ICT has switched them off.
const V = require('./validate');
const { writeFileAtomic, readJsonOr } = require('./fsx');

const SAM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function load(cfg) {
  const d = readJsonOr(cfg.phoneUsersFile, null) || {};
  return { users: Array.isArray(d.users) ? d.users : [] };
}
function save(cfg, data) { writeFileAtomic(cfg.phoneUsersFile, JSON.stringify(data, null, 2) + '\n', 0o640); }
const find = (data, sam) => data.users.find(u => u.sam === sam);

// Add a person and give them a browser phone, next free number in the configured department.
// -> { user, ext, created: true } | { user, created: false } when already listed. Throws on no free number.
function add(cfg, store, sam, name, group, who) {
  sam = String(sam || '').toLowerCase();
  if (!SAM_RE.test(sam)) throw new Error('not a domain account name: ' + sam);
  const data = load(cfg);
  const have = find(data, sam);
  if (have) return { user: have, created: false };
  const dept = (cfg.ad && cfg.ad.dept) || 'ICT';
  const dir = V.normalizeDirectory(store.loadDirectory());
  const e = V.normalizeExtension({ name: String(name || sam).slice(0, 60), dept, model: 'webphone', voicemail: true });
  e.ext = V.nextFreeExt(dir, dept) || '';
  if (!e.ext) throw new Error('no free extension in department ' + dept);
  dir.extensions.push(e);
  const problems = V.validateDirectory(dir, cfg);
  if (problems.length) throw new Error(problems.join('; '));
  store.saveDirectory(dir, who, 'add extension', e.ext + ' ' + e.name + ' (webphone, phone user ' + sam + ')');
  const user = { sam, name: e.name, ext: e.ext, group: group || '', addedAt: new Date().toISOString(), addedBy: who, lastSignIn: null, disabled: false };
  data.users.push(user);
  save(cfg, data);
  store.audit({ who, action: 'add phone user', detail: sam + ' -> ' + e.ext + (group ? ' (' + group + ')' : '') });
  return { user, ext: e.ext, created: true };
}

function update(cfg, sam, fields) {
  const data = load(cfg);
  const u = find(data, sam);
  if (!u) return null;
  Object.assign(u, fields);
  save(cfg, data);
  return u;
}

module.exports = { load, save, find, add, update, SAM_RE };
