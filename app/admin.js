#!/usr/bin/env node
'use strict';
/*
 * pmc-pbx command line for the service host.
 *   node admin.js adduser <name> <role>     role: viewer | editor | admin. Password from PMC_PBX_PASSWORD or prompt.
 *   node admin.js passwd  <name>            reset a password
 *   node admin.js users                     list users
 *   node admin.js check                     validate directory.json
 *   node admin.js apply                     generate config and reload the engine, as the Apply button does
 * Config dir: PMC_PBX_CONF (default /etc/pmc-pbx).
 */
const readline = require('readline');
const { loadConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const V = require('./lib/validate');
const auth = require('./lib/auth');
const { applyChanges } = require('./server');

const cfg = loadConfig(process.env.PMC_PBX_CONF || '/etc/pmc-pbx');
const store = new Store(cfg);
const [cmd, a1, a2] = process.argv.slice(2);

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
      for (const u of auth.loadUsers(cfg.usersFile).users) console.log(u.name + '  ' + u.role + (u.disabled ? '  disabled' : '') + '  created ' + u.createdAt);
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
    case 'apply': {
      const r = await applyChanges(cfg, store, 'cli');
      if (r.problems) { console.error('STOP: ' + r.problems.join('; ')); process.exit(1); }
      console.log('generated version ' + r.manifest.directoryVersion + ': ' + r.manifest.extensions + ' extensions, ' + r.manifest.phones + ' phones, ' + r.secretsCreated + ' new secret(s)');
      for (const s of r.reload.steps) console.log('  ' + s.cli + ': ' + (s.ok ? 'ok' : 'FAILED') + (s.out ? ' ' + s.out : ''));
      if (!r.ok) { console.error('engine reload failed: ' + r.error); process.exit(1); }
      break;
    }
    default:
      console.error('commands: adduser <name> <role> | passwd <name> | users | check | apply');
      process.exit(2);
  }
})().catch(err => { console.error(err.message); process.exit(1); });
