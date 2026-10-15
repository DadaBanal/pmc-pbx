#!/usr/bin/env node
'use strict';
/*
 * pmc-pbx command line for the service host.
 *   node admin.js adduser <name> <role>     role: phone | viewer | editor | admin. Password from PMC_PBX_PASSWORD or prompt.
 *   node admin.js passwd  <name>            reset a password
 *   node admin.js users                     list users
 *   node admin.js check                     validate directory.json
 *   node admin.js apply                     generate config and reload the engine, as the Apply button does
 *   node admin.js addext <dept> <model> <name...>   add an extension, next free number in that department
 *   node admin.js adddept <name> <from> <to>        add a department and its number range
 *   node admin.js addphone <dept> <model> <ext> <mac> <name...>   add a desk phone on a chosen number
 *   node admin.js link <user> <ext|none>    link a sign-in to one extension (the browser phone), or unlink
 *   node admin.js phoneuser <sam> <name...>  put a Windows account on the phone users list with a browser phone
 *   node admin.js phoneusers                the phone users list
 *   node admin.js sync-members [--dry-run]  read AD group members as JSON on stdin, reconcile the list, apply if added
 * Config dir: PMC_PBX_CONF (default /etc/pmc-pbx).
 */
const fs = require('fs');
const readline = require('readline');
const { loadConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const V = require('./lib/validate');
const auth = require('./lib/auth');
const { applyChanges } = require('./server');
const PU = require('./lib/phoneusers');

const cfg = loadConfig(process.env.PMC_PBX_CONF || '/etc/pmc-pbx');
const store = new Store(cfg);
const [cmd, a1, a2, ...rest] = process.argv.slice(2);

async function password(prompt) {
  if (process.env.PMC_PBX_PASSWORD) return process.env.PMC_PBX_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans); }));
}

(async () => {
  switch (cmd) {
    case 'adduser': {
      if (!a1 || !a2) { console.error('usage: adduser <name> <role>'); process.exit(2); }
      const data = auth.loadUsers(cfg.usersFile);
      if (data.users.some(u => u.name === a1)) { console.error('user exists; use passwd'); process.exit(1); }
      auth.setPassword(data, a1, await password('password for ' + a1 + ': '), a2, 'cli');
      auth.saveUsers(cfg.usersFile, data);
      store.audit({ who: 'cli', action: 'add user', detail: a1 + ' as ' + a2 });
      console.log('user ' + a1 + ' (' + a2 + ') saved to ' + cfg.usersFile);
      break;
    }
    case 'passwd': {
      if (!a1) { console.error('usage: passwd <name>'); process.exit(2); }
      const data = auth.loadUsers(cfg.usersFile);
      if (!data.users.some(u => u.name === a1)) { console.error('no such user'); process.exit(1); }
      auth.setPassword(data, a1, await password('new password for ' + a1 + ': '), null, 'cli');
      auth.saveUsers(cfg.usersFile, data);
      store.audit({ who: 'cli', action: 'edit user', detail: a1 + ': password reset' });
      console.log('password updated');
      break;
    }
    case 'users': {
      for (const u of auth.loadUsers(cfg.usersFile).users) console.log(u.name + '  ' + u.role + (u.ext ? '  phone ' + u.ext : '') + (u.disabled ? '  disabled' : '') + '  created ' + u.createdAt);
      break;
    }
    case 'check': {
      const dir = V.normalizeDirectory(store.loadDirectory());
      const problems = V.validateDirectory(dir, cfg);
      console.log('directory version ' + dir.version + ': ' + dir.extensions.length + ' extensions, ' + dir.extensions.filter(e => e.mac).length + ' phones, ' + dir.departments.length + ' departments');
      if (problems.length) { problems.forEach(p => console.log('  - ' + p)); process.exit(1); }
      console.log('ok');
      break;
    }
    case 'addext': {
      const name = rest.join(' ').trim();
      if (!a1 || !a2 || !name) { console.error('usage: addext <dept> <model> <name...>'); process.exit(2); }
      const dir = V.normalizeDirectory(store.loadDirectory());
      const e = V.normalizeExtension({ name, dept: a1, model: a2, voicemail: true });
      e.ext = V.nextFreeExt(dir, e.dept) || '';
      if (!e.ext) { console.error('no free extension in department ' + a1); process.exit(1); }
      dir.extensions.push(e);
      const problems = V.validateDirectory(dir, cfg);
      if (problems.length) { console.error('STOP: ' + problems.join('; ')); process.exit(1); }
      const version = store.saveDirectory(dir, 'cli', 'add extension', e.ext + ' ' + e.name + ' (' + e.model + ')');
      console.log('extension ' + e.ext + ' "' + e.name + '" (' + e.model + ', ' + e.dept + ') added, directory version ' + version + '. Run apply.');
      break;
    }
    case 'adddept': {
      // a department and its number range (Dada, 15 Oct 2026: PMO Support is 6666, outside every range then)
      const [from, to] = [Number(a2), Number(rest[0])];
      if (!a1 || !Number.isInteger(from) || !Number.isInteger(to)) { console.error('usage: adddept <name> <from> <to>'); process.exit(2); }
      const dir = V.normalizeDirectory(store.loadDirectory());
      if (dir.departments.some(d => d.name.toLowerCase() === a1.toLowerCase())) { console.error('department ' + a1 + ' exists'); process.exit(1); }
      dir.departments.push({ name: a1, from, to });
      const problems = V.validateDirectory(dir, cfg);
      if (problems.length) { console.error('STOP: ' + problems.join('; ')); process.exit(1); }
      const version = store.saveDirectory(dir, 'cli', 'add department', a1 + ' ' + from + '-' + to);
      console.log('department ' + a1 + ' ' + from + '-' + to + ' added, directory version ' + version + '.');
      break;
    }
    case 'addphone': {
      // a desk phone on a chosen number: addphone <dept> <model> <ext> <mac> <name...>
      const [ext, mac] = [rest[0], rest[1]];
      const name = rest.slice(2).join(' ').trim();
      if (!a1 || !a2 || !/^\d{4}$/.test(ext || '') || !mac || !name) { console.error('usage: addphone <dept> <model> <ext> <mac> <name...>'); process.exit(2); }
      const dir = V.normalizeDirectory(store.loadDirectory());
      if (dir.extensions.some(x => x.ext === ext)) { console.error('extension ' + ext + ' exists'); process.exit(1); }
      const e = V.normalizeExtension({ ext, name, dept: a1, model: a2, mac, voicemail: true });
      dir.extensions.push(e);
      const problems = V.validateDirectory(dir, cfg);
      if (problems.length) { console.error('STOP: ' + problems.join('; ')); process.exit(1); }
      const version = store.saveDirectory(dir, 'cli', 'add extension', e.ext + ' ' + e.name + ' (' + e.model + ', ' + e.mac + ')');
      console.log('extension ' + e.ext + ' "' + e.name + '" (' + e.model + ', ' + e.mac + ', ' + e.dept + ') added, directory version ' + version + '. Run apply.');
      break;
    }
    case 'phoneuser': {
      // the group check still happens at every sign-in; this only gives the person their phone ahead of it
      const name = rest.join(' ').trim();
      if (!a1 || !a2) { console.error('usage: phoneuser <windows-name> <display name...>'); process.exit(2); }
      const display = (a2 + ' ' + name).trim();
      const r = PU.add(cfg, store, a1, display, cfg.ad ? cfg.ad.groups[0] : '', 'cli');
      console.log(r.created ? a1 + ' added as ' + r.ext + ' "' + display + '". Run apply.' : a1 + ' is already on the list as ' + r.user.ext);
      break;
    }
    case 'sync-members': {
      // stdin: [{ "sam": "...", "name": "...", "group": "..." }, ...] from DND-SQL01's scheduled AD read. Strictly
      // parsed: anything that is not that shape is refused whole. Applies only what it added, and only when nothing
      // else is waiting, so a sync never pushes someone's unapplied edits live.
      const dry = a1 === '--dry-run';
      // read stdin as a stream to its end: under sshd it arrives in chunks over a socket, and one blocking read can
      // return part of it (14 Oct 2026: a 1,139-byte member list from DND-SQL01 arrived as "not JSON")
      const raw = await new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        process.stdin.on('data', c => { size += c.length; if (size > 1024 * 1024) { reject(new Error('stdin over 1 MB')); process.stdin.destroy(); } else chunks.push(c); });
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
      }).catch(e => { console.error(e.message); process.exit(2); });
      let members;
      // Windows PowerShell 5.1 put a UTF-8 byte-order mark (ef bb bf) in front of the list (MEASURED 14 Oct 2026)
      try { members = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { console.error('stdin is not JSON (' + Buffer.byteLength(raw) + ' bytes, starts ' + Buffer.from(raw).subarray(0, 16).toString('hex') + ', ends ' + Buffer.from(raw).subarray(-8).toString('hex') + '): ' + e.message.slice(0, 80)); process.exit(2); }
      if (!Array.isArray(members) || members.length > 5000 || !members.every(m => m && typeof m.sam === 'string' && m.sam.length <= 64 && (m.name === undefined || (typeof m.name === 'string' && m.name.length <= 128)))) {
        console.error('stdin must be a list of { sam, name, group }'); process.exit(2);
      }
      if (dry) {
        // the same rules as the real run (review 14 Oct 2026: the first preview skipped the safety guard and said it
        // "would switch off" everyone for an empty list, which the real sync refuses)
        const p = PU.plan(cfg, members);
        console.log('would add: ' + (p.add.join(', ') || 'none') + ' | would switch back on: ' + (p.reEnable.join(', ') || 'none'));
        console.log(p.refused ? 'would switch off: NOBODY - ' + p.refused : 'would switch off: ' + (p.leave.join(', ') || 'none'));
        break;
      }
      const m0 = store.loadManifest(), d0 = V.normalizeDirectory(store.loadDirectory());
      const clean = !!m0 && m0.directoryVersion === d0.version;
      const r = PU.reconcile(cfg, store, members, 'ad-sync');
      console.log('added: ' + (r.added.join(', ') || 'none') + ' | back on: ' + (r.reEnabled.join(', ') || 'none') + ' | switched off: ' + (r.disabled.join(', ') || 'none') + (r.refused ? ' | REFUSED: ' + r.refused : '') + (r.skipped.length ? ' | skipped: ' + r.skipped.join('; ') : ''));
      if (r.added.length && clean) {
        const ap = await applyChanges(cfg, store, 'ad-sync');
        console.log('apply: ' + (ap.ok ? 'ok, verified ' + ap.verified.endpoints + ' extensions' : 'FAILED ' + (ap.error || (ap.problems || []).join('; '))));
        if (!ap.ok) process.exit(1);
      } else if (r.added.length) console.log('apply: NOT run, other changes are waiting for PMO ICT');
      if (r.refused) process.exit(3);
      break;
    }
    case 'phoneusers': {
      const list = PU.load(cfg).users;
      for (const u of list) console.log(u.sam + '  ' + u.ext + '  ' + u.name + (u.disabled ? '  OFF' : '') + '  last sign-in ' + (u.lastSignIn || 'never'));
      console.log(list.length + ' phone user(s)');
      break;
    }
    case 'link': {
      if (!a1 || !a2) { console.error('usage: link <user> <ext|none>'); process.exit(2); }
      const data = auth.loadUsers(cfg.usersFile);
      const u = data.users.find(x => x.name === a1);
      if (!u) { console.error('no such user'); process.exit(1); }
      if (a2 === 'none') { delete u.ext; }
      else {
        if (!/^\d{4}$/.test(a2)) { console.error('extension must be four digits'); process.exit(2); }
        const dir = V.normalizeDirectory(store.loadDirectory());
        if (!dir.extensions.some(x => x.ext === a2)) { console.error('extension ' + a2 + ' is not in the directory'); process.exit(1); }
        u.ext = a2;
      }
      auth.saveUsers(cfg.usersFile, data);
      store.audit({ who: 'cli', action: 'edit user', detail: a1 + ': ' + (a2 === 'none' ? 'phone unlinked' : 'phone ' + a2) });
      console.log(a1 + (a2 === 'none' ? ' unlinked' : ' linked to ' + a2));
      break;
    }
    case 'apply': {
      const r = await applyChanges(cfg, store, 'cli');
      if (r.problems) { console.error('STOP: ' + r.problems.join('; ')); process.exit(1); }
      console.log('generated version ' + r.manifest.directoryVersion + ': ' + r.manifest.extensions + ' extensions, ' + r.manifest.phones + ' phones, ' + r.secretsCreated + ' new secret(s)');
      for (const s of r.reload.steps) console.log('  ' + s.cli + ': ' + (s.ok ? 'ok' : 'FAILED') + (s.out ? ' ' + s.out : ''));
      if (!r.ok) { console.error('engine reload failed: ' + r.error); process.exit(1); }
      break;
    }
    default:
      console.error('commands: adduser <name> <role> | passwd <name> | users | check | apply | addext <dept> <model> <name...> | link <user> <ext|none> | phoneuser <sam> <name...> | phoneusers');
      process.exit(2);
  }
})().catch(err => { console.error(err.message); process.exit(1); });
