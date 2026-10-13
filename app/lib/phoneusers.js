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
  if (!dir.departments.some(d => d.name === dept)) throw new Error('department ' + dept + ' is not set up in the directory');
  // 40 is the directory's limit; a longer Windows display name used to fail every sign-in with 409 (review 14 Oct)
  const e = V.normalizeExtension({ name: String(name || sam).replace(/[;"]/g, ' ').trim().slice(0, 40).trim() || sam, dept, model: 'webphone', voicemail: true });
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

// Take someone off the list for good, with their browser phone. Switching off keeps both; this removes both.
function remove(cfg, store, sam, who) {
  const data = load(cfg);
  const u = find(data, sam);
  if (!u) return null;
  data.users = data.users.filter(x => x !== u);
  save(cfg, data);
  const dir = V.normalizeDirectory(store.loadDirectory());
  const e = dir.extensions.find(x => x.ext === u.ext && x.model === 'webphone');
  if (e) {
    dir.extensions = dir.extensions.filter(x => x !== e);
    for (const x of dir.extensions) x.keys = x.keys.filter(k => k.ext !== e.ext);
    store.saveDirectory(dir, who, 'remove extension', e.ext + ' ' + e.name + ' (phone user ' + sam + ' removed)');
  }
  store.audit({ who, action: 'remove phone user', detail: sam + (e ? ' and extension ' + e.ext : '') });
  return { user: u, ext: e ? e.ext : null };
}

// Bring the list in line with the AD groups (Dada, 14 Oct 2026: "auto activate extensions on those once added to the
// group"). members: [{ sam, name, group }] as read from AD by DND-SQL01. Adds anyone new with a browser phone;
// switches off anyone no longer in any group (marked disabledBy 'sync'), and back on if they return; never touches
// someone PMO ICT switched off by hand (disabledBy 'admin'). Refuses to switch anyone off when the member list is
// empty or would take more than half the list: a failed or partial AD read must never cut everyone off.
function reconcile(cfg, store, members, who) {
  const out = { added: [], reEnabled: [], disabled: [], refused: null, skipped: [] };
  const want = new Map();
  for (const m of Array.isArray(members) ? members : []) {
    const sam = String((m && m.sam) || '').toLowerCase();
    if (!SAM_RE.test(sam)) { out.skipped.push(String((m && m.sam) || '?')); continue; }
    if (!want.has(sam)) want.set(sam, { sam, name: String(m.name || sam), group: String(m.group || '') });
  }
  for (const m of want.values()) {
    const have = find(load(cfg), m.sam);
    if (!have) {
      try { const r = add(cfg, store, m.sam, m.name, m.group, who); out.added.push(m.sam + ' ' + r.ext); }
      catch (e) { out.skipped.push(m.sam + ': ' + e.message); }
    } else if (have.disabled && have.disabledBy === 'sync') {
      update(cfg, m.sam, { disabled: false, disabledBy: null });
      store.audit({ who, action: 'edit phone user', detail: m.sam + ': switched on (back in ' + (m.group || 'a phone group') + ')' });
      out.reEnabled.push(m.sam);
    }
  }
  const data = load(cfg);
  const leaving = data.users.filter(u => !u.disabled && !want.has(u.sam));
  const active = data.users.filter(u => !u.disabled).length;
  if (leaving.length && (want.size === 0 || leaving.length > Math.max(1, Math.floor(active / 2)))) {
    out.refused = 'would switch off ' + leaving.length + ' of ' + active + ' active phone users (AD returned ' + want.size + ' members): refused, nobody switched off';
    store.audit({ who, action: 'phone user sync refused', detail: out.refused });
    return out;
  }
  for (const u of leaving) {
    update(cfg, u.sam, { disabled: true, disabledBy: 'sync' });
    store.audit({ who, action: 'edit phone user', detail: u.sam + ': switched off (no longer in a phone group)' });
    out.disabled.push(u.sam);
  }
  return out;
}

module.exports = { load, save, find, add, update, remove, reconcile, SAM_RE };
