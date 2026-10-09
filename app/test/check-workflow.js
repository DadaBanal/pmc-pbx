#!/usr/bin/env node
'use strict';
/*
 * Check the CI workflow's own shell before CI runs it.
 *
 * Written 9 Oct 2026 after three pushes in a row broke CI, two of them because a line of shell inside the
 * YAML was wrong and nothing checked it: a `node -e "..."` command carrying a literal backslash-n, which node
 * cannot parse. The workflow is the one place where code was not being checked by anything.
 *
 *   node app/test/check-workflow.js [.github/workflows/ci.yml]
 *
 * Checks, with no dependency on a YAML parser (none is installed, and none will be installed for this):
 *   1. no shell line carries a literal backslash-n, which is never valid in a double-quoted shell string here
 *   2. every `run:` block parses as shell (bash -n), PowerShell steps excepted
 *   3. every test file on disk is named in the workflow
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const file = process.argv[2] || path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');
const BS = String.fromCharCode(92);
let bad = 0;
const fail = m => { console.error('FAILED: ' + m); bad++; };

// 1. a literal backslash-n in a command line
lines.forEach((l, i) => {
  const t = l.trim();
  if (t.startsWith('#') || !t) return;
  if (l.includes(BS + 'n') && !l.includes("'" + BS + "n'") && !/^\s*#/.test(l)) {
    fail('line ' + (i + 1) + ' carries a literal backslash-n, which no shell will turn into a newline: ' + t.slice(0, 80));
  }
});

// 2. every run block must parse as shell
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (t === 'run: |') {
    const indent = lines[i].length - lines[i].trimStart().length;
    const body = [];
    i++;
    while (i < lines.length && (!lines[i].trim() || (lines[i].length - lines[i].trimStart().length) > indent)) {
      body.push(lines[i].slice(indent + 2)); i++;
    }
    i--;
    blocks.push({ at: i + 1, body: body.join('\n') });
  } else if (t.startsWith('run: ')) {
    blocks.push({ at: i + 1, body: t.slice(5) });
  }
}
for (const b of blocks) {
  if (/Parser\]::ParseFile|\$PWD\/vm\//.test(b.body)) continue;   // the PowerShell step
  const tmp = path.join(os.tmpdir(), 'pmc-wf-' + process.pid + '-' + b.at + '.sh');
  fs.writeFileSync(tmp, b.body);
  try { execFileSync('bash', ['-n', tmp], { stdio: 'pipe' }); }
  catch (err) { fail('the run block ending at line ' + b.at + ' is not valid shell: ' + String(err.stderr || err).slice(0, 200)); }
  finally { try { fs.unlinkSync(tmp); } catch (e) { /* leave it */ } }
}

// 3. every test file must be named in the workflow
const testDir = path.join(__dirname);
const onDisk = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();
const named = onDisk.filter(f => src.includes('app/test/' + f));
if (named.length !== onDisk.length) {
  fail('CI does not run ' + onDisk.filter(f => !named.includes(f)).join(', '));
}

if (bad) process.exit(1);
console.log('workflow ok: ' + blocks.length + ' run blocks parse, ' + onDisk.length + ' test files all named');
