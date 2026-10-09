#!/usr/bin/env node
'use strict';
/*
 * Check the CI workflow itself, before CI runs it.
 *
 * Written 9 Oct 2026 after five CI failures in one afternoon. Two classes of defect caused all of them, and
 * both lived in the workflow, the one place in this repository holding code that nothing checked:
 *
 *   A. a command line carrying a literal backslash-n, which no shell turns into a newline, so node is handed
 *      a stray backslash and dies on a syntax error;
 *   B. an assertion naming a MAC, an extension or a count taken from the sample directory, which stops being
 *      true the moment the fleet changes. Assertions about generated output must derive from the directory,
 *      which is what app/test/ci-assert.js is for.
 *
 *   node app/test/check-workflow.js [path/to/ci.yml]
 *
 * Exits 1 and names every problem, or 0 and says what it proved.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const file = process.argv[2] || path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');
const BACKSLASH = String.fromCharCode(92);

const problems = [];
const fail = m => problems.push(m);
const isComment = l => l.trim().startsWith('#');
const MAC = /[0-9a-f]{12}/;
const EXTENSION = /[1-9][0-9]{3}/;
// a line that looks at what the generator wrote
const TOUCHES_OUTPUT = /tmp\/out|out\/phones|out\/asterisk|_pmc\.conf|phonebook\.xml/;
// a line that asserts rather than merely does
const ASSERTS = /grep|test -s|test "|\[ -|includes/;

// ---- A. a literal backslash-n in a command ----------------------------------------------------
lines.forEach((l, i) => {
  if (isComment(l) || !l.trim()) return;
  if (l.includes(BACKSLASH + 'n')) {
    fail('line ' + (i + 1) + ': a literal backslash-n, which no shell turns into a newline -> ' + l.trim().slice(0, 80));
  }
});

// ---- B. an assertion about generated output that names a fixture detail -----------------------
lines.forEach((l, i) => {
  if (isComment(l) || !l.trim()) return;
  if (!TOUCHES_OUTPUT.test(l)) return;
  if (MAC.test(l)) {
    fail('line ' + (i + 1) + ': asserts about generated output using a MAC from the directory; derive it with ci-assert.js -> ' + l.trim().slice(0, 80));
  } else if (EXTENSION.test(l) && ASSERTS.test(l)) {
    fail('line ' + (i + 1) + ': asserts about generated output using an extension number; derive it with ci-assert.js -> ' + l.trim().slice(0, 80));
  }
});

// ---- C. every run block must be valid shell ---------------------------------------------------
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (t === 'run: |') {
    const indent = lines[i].length - lines[i].trimStart().length;
    const body = [];
    i++;
    while (i < lines.length && (!lines[i].trim() || (lines[i].length - lines[i].trimStart().length) > indent)) {
      body.push(lines[i].slice(indent + 2));
      i++;
    }
    i--;
    blocks.push({ at: i + 1, body: body.join('\n') });
  } else if (t.startsWith('run: ')) {
    blocks.push({ at: i + 1, body: t.slice(5) });
  }
}
let checkedBlocks = 0;
for (const b of blocks) {
  if (/Parser\]::ParseFile|\$PWD\/vm\//.test(b.body)) continue;      // the PowerShell step
  const tmp = path.join(os.tmpdir(), 'pmc-wf-' + process.pid + '-' + b.at + '.sh');
  fs.writeFileSync(tmp, b.body);
  try {
    execFileSync('bash', ['-n', tmp], { stdio: 'pipe' });
    checkedBlocks++;
  } catch (err) {
    fail('the run block ending at line ' + b.at + ' is not valid shell: ' + String(err.stderr || err.message).trim().slice(0, 200));
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* a leftover temp file is not a failure */ }
  }
}

// ---- D. every test file on disk must be named in the workflow ---------------------------------
const onDisk = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
const missing = onDisk.filter(f => !src.includes('app/test/' + f));
if (missing.length) fail('CI does not run: ' + missing.join(', '));

if (problems.length) {
  for (const p of problems) console.error('FAILED: ' + p);
  process.exit(1);
}
console.log('workflow ok: ' + checkedBlocks + ' run blocks parse, ' + onDisk.length +
  ' test files all named, no fixture details in assertions');
