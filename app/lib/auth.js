'use strict';
// Named users with roles, scrypt password hashes, HMAC-signed session tokens. Built-ins only.
const crypto = require('crypto');
const { writeFileAtomic, readJsonOr } = require('./fsx');

const ROLES = { viewer: 1, editor: 2, admin: 3 };
const MIN_PASSWORD = 10;

function loadUsers(file) {
  const u = readJsonOr(file, { users: [] });
  u.users = Array.isArray(u.users) ? u.users : [];
  return u;
}

function saveUsers(file, data) { writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', 0o600); }

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return 'password must be at least ' + MIN_PASSWORD + ' characters';
  return null;
}

function setPassword(data, name, password, role, by) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  if (!/^[a-z][a-z0-9._-]{1,31}$/.test(name)) throw new Error('user name: lower-case letters, digits, dot, dash, underscore, 2-32 characters');
  if (role && !ROLES[role]) throw new Error('role must be viewer, editor or admin');
  const salt = crypto.randomBytes(16).toString('hex');
  let u = data.users.find(x => x.name === name);
  if (!u) { u = { name, role: role || 'viewer', createdAt: new Date().toISOString(), createdBy: by || 'cli' }; data.users.push(u); }
  if (role) u.role = role;
  u.salt = salt;
  u.hash = hashPassword(password, salt);
  u.passwordAt = new Date().toISOString();
  return u;
}

function verifyPassword(user, password) {
  if (!user || !user.salt || !user.hash) return false;
  const a = Buffer.from(hashPassword(password, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeToken(key, name, hours) {
  const payload = Buffer.from(JSON.stringify({ n: name, e: Date.now() + hours * 3600 * 1000, r: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return payload + '.' + mac;
}

function readToken(key, token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  if (expect.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(mac))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!data || !data.n || !data.e || data.e < Date.now()) return null;
  return { name: data.n, exp: data.e };
}

function roleAtLeast(role, min) { return (ROLES[role] || 0) >= (ROLES[min] || 99); }

module.exports = { ROLES, MIN_PASSWORD, loadUsers, saveUsers, setPassword, verifyPassword, passwordProblem, makeToken, readToken, roleAtLeast };
