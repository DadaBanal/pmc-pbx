#!/usr/bin/env node
'use strict';
/*
 * pmc-pbx generator, command line. The same code the admin screen's Apply button runs, without the reload.
 *   node gen.js [--conf /etc/pmc-pbx] [--out /var/lib/pmc-pbx/out] [--check]
 * --check validates and prints counts without writing anything.
 */
const { loadConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const V = require('./lib/validate');
const G = require('./lib/generate');

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig(args.conf || process.env.PMC_PBX_CONF || '/etc/pmc-pbx');
if (args.out) cfg.outDir = args.out;
const store = new Store(cfg);
const dir = V.normalizeDirectory(store.loadDirectory());

const problems = V.validateDirectory(dir, cfg);
if (problems.length) {
  console.error('STOP: ' + problems.length + ' problem(s) in directory.json:');
  problems.forEach(p => console.error('  - ' + p));
  process.exit(1);
}
const secrets = store.loadSecrets();
const created = G.ensureSecrets(dir, secrets);
const phones = dir.extensions.filter(e => e.mac).length;
console.log('directory: ' + dir.extensions.length + ' extensions, ' + phones + ' phones, ' + created + ' new secret(s)' + (args.check ? ' (check only, nothing written)' : ''));
if (args.check) process.exit(0);
if (created) store.saveSecrets(secrets);
const manifest = G.generate(cfg, dir, secrets, cfg.outDir);
console.log('written to ' + cfg.outDir + ' (directory version ' + manifest.directoryVersion + ', hash ' + manifest.directoryHash + ')');

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      if (i + 1 < a.length && !a[i + 1].startsWith('--')) { o[k] = a[i + 1]; i++; } else { o[k] = true; }
    }
  }
  return o;
}
