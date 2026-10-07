'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// Write to a temp file beside the target, then rename: never a half-written file.
function writeFileAtomic(file, content, mode) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
  fs.writeFileSync(tmp, content, { mode: mode || 0o644 });
  // Inherit the directory's group so a 0640 file stays readable by the engine (group asterisk on the VM).
  // A directory with the setgid bit does this by itself; this covers the case where it is not set.
  if (process.platform !== 'win32') {
    try { fs.chownSync(tmp, -1, fs.statSync(path.dirname(file)).gid); } catch (err) { /* not permitted: leave as written */ }
  }
  fs.renameSync(tmp, file);
}

function readJsonOr(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return fallback; }
}

function randomSecret(n) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

module.exports = { ensureDir, writeFileAtomic, readJsonOr, randomSecret, sha256 };
