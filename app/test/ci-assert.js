#!/usr/bin/env node
'use strict';
/*
 * The checks CI makes against a running engine, as a script instead of one-liners buried in YAML.
 *
 * Written 9 Oct 2026 after two CI failures in a row caused by counts typed into the workflow by hand: when the
 * directory changed, the workflow was still asserting the old numbers. Nothing here hard-codes a count; every
 * expectation is derived from the directory the engine was given. It is a script so it can be run and proven
 * locally, which a line of YAML cannot be.
 *
 *   node app/test/ci-assert.js endpoints <directory.json> <pjsip-show-endpoints.txt>
 *   node app/test/ci-assert.js dialplan  <directory.json> <dialplan-show.txt>
 *   node app/test/ci-assert.js health    <directory.json> <health.json>
 *
 * Exit 0 and a line saying what was proven, or exit 1 and what was missing.
 */
const fs = require('fs');

const [, , what, dirPath, filePath] = process.argv;
if (!what || !dirPath || !filePath) {
  console.error('usage: ci-assert.js endpoints|dialplan|health <directory.json> <file>');
  process.exit(2);
}

const read = p => fs.readFileSync(p, 'utf8');
const dir = JSON.parse(read(dirPath));
const exts = dir.extensions || [];
const q = "'";

function fail(msg) { console.error('FAILED: ' + msg); process.exit(1); }

if (what === 'endpoints') {
  const text = read(filePath);
  // Asterisk prints " Endpoint:  1101/1101 ..."; the extension is followed by a slash
  const missing = exts.filter(e => !text.includes(' ' + e.ext + '/'));
  if (missing.length) fail('the engine did not load ' + missing.length + ' extension(s): ' + missing.map(e => e.ext).join(', '));
  console.log('engine loaded all ' + exts.length + ' extensions');
} else if (what === 'dialplan') {
  const text = read(filePath);
  // the dialplan prints hints as "  '1101' => hint: PJSIP/1101"
  const missing = exts.filter(e => !text.includes(q + e.ext + q));
  if (missing.length) fail('the dialplan is missing ' + missing.length + ' hint(s): ' + missing.map(e => e.ext).join(', '));
  if (!text.includes(q + '9196' + q)) fail('the echo test number 9196 is not in the dialplan');
  console.log('dialplan has all ' + exts.length + ' hints and the test numbers');
} else if (what === 'health') {
  const h = JSON.parse(read(filePath));
  const wantPhones = exts.filter(e => e.mac).length;
  if (h.phones !== wantPhones || h.extensions !== exts.length) {
    fail('health reports ' + h.phones + ' phones and ' + h.extensions + ' extensions; the directory has ' +
      wantPhones + ' and ' + exts.length);
  }
  console.log('health agrees with the directory: ' + wantPhones + ' phones, ' + exts.length + ' extensions');
} else {
  console.error('unknown check: ' + what);
  process.exit(2);
}
