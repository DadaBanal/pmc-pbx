'use strict';
// Directory rules. Every write to directory.json passes through validateDirectory first.

const phones = require('./phones');

const EXT_RE = /^[1-9][0-9]{3}$/;
const MAC_RE = /^[0-9a-f]{12}$/;
// The models come from the phone registry, so adding a vendor driver is the only change needed.
const MODELS = phones.modelIds();
const SITES = ['PMC', 'JRBY'];

function normalizeExtension(e) {
  e = e || {};
  return {
    ext: String(e.ext == null ? '' : e.ext).trim(),
    name: String(e.name || '').trim().replace(/\s+/g, ' '),
    dept: String(e.dept || '').trim(),
    site: String(e.site || 'PMC').trim() || 'PMC',
    model: String(e.model || 'T31P').trim(),
    // only separators are stripped; anything else stays so validation can name it
    mac: String(e.mac || '').trim().toLowerCase().replace(/[\s:.\-]/g, ''),
    voicemail: !!e.voicemail,
    keys: Array.isArray(e.keys) ? e.keys
      .filter(k => k && (k.ext || k.type))
      .map(k => ({ type: String(k.type || 'blf').trim(), ext: String(k.ext || '').trim(), label: String(k.label || '').trim() }))
      : [],
    notes: String(e.notes || '').trim()
  };
}

function normalizeDepartment(d) {
  d = d || {};
  const lo = Number(d.from != null ? d.from : (Array.isArray(d.range) ? d.range[0] : NaN));
  const hi = Number(d.to != null ? d.to : (Array.isArray(d.range) ? d.range[1] : NaN));
  return { name: String(d.name || '').trim(), from: lo, to: hi };
}

function validateDirectory(dir, cfg) {
  const out = [];
  if (cfg) {
    if (!cfg.fqdn) out.push('config.json: fqdn missing');
    if (!cfg.externalIp) out.push('config.json: externalIp missing');
    if (!Array.isArray(cfg.localNets) || !cfg.localNets.length) out.push('config.json: localNets missing');
  }
  if (!dir || !Array.isArray(dir.extensions)) { out.push('directory: "extensions" array missing'); return out; }
  const depts = Array.isArray(dir.departments) ? dir.departments : [];
  const deptByName = new Map();
  for (const d of depts) {
    if (!d.name) { out.push('department with no name'); continue; }
    if (deptByName.has(d.name)) out.push('department ' + d.name + ': duplicate');
    if (!(Number.isInteger(d.from) && Number.isInteger(d.to) && d.from >= 1000 && d.to <= 9999 && d.from <= d.to)) {
      out.push('department ' + d.name + ': range must be two 4-digit numbers, from <= to');
    }
    deptByName.set(d.name, d);
  }
  for (const a of depts) for (const b of depts) {
    if (a !== b && a.name < b.name && Number.isInteger(a.from) && Number.isInteger(b.from) && a.from <= b.to && b.from <= a.to) {
      out.push('departments ' + a.name + ' and ' + b.name + ': ranges overlap');
    }
  }
  const seenExt = new Set(), seenMac = new Set();
  for (const e of dir.extensions) {
    const id = e.ext || '?';
    if (!EXT_RE.test(e.ext)) out.push(id + ': extension must be 4 digits and not start with 0');
    if (seenExt.has(e.ext)) out.push(id + ': duplicate extension');
    seenExt.add(e.ext);
    if (!e.name) out.push(id + ': name missing');
    if (e.name && e.name.length > 40) out.push(id + ': name longer than 40 characters');
    if (!SITES.includes(e.site)) out.push(id + ': site must be one of ' + SITES.join(', '));
    if (!MODELS.includes(e.model)) out.push(id + ': model must be one of ' + MODELS.join(', '));
    if (MODELS.includes(e.model) && e.keys.length && !phones.supportsKeys(e.model)) {
      const spec = phones.modelSpec(e.model);
      out.push(id + ': ' + spec.label + ' has no programmable keys, so its ' + e.keys.length + ' button(s) cannot be set');
    }
    if (e.mac) {
      if (!MAC_RE.test(e.mac)) out.push(id + ': MAC must be 12 hex characters');
      if (seenMac.has(e.mac)) out.push(id + ': duplicate MAC ' + e.mac);
      seenMac.add(e.mac);
    }
    if (depts.length && e.dept && !deptByName.has(e.dept)) out.push(id + ': unknown department ' + e.dept);
    if (e.dept && deptByName.has(e.dept) && EXT_RE.test(e.ext)) {
      const d = deptByName.get(e.dept);
      const n = Number(e.ext);
      if (Number.isInteger(d.from) && (n < d.from || n > d.to)) out.push(id + ': outside the ' + d.name + ' range ' + d.from + '-' + d.to);
    }
    const spec = MODELS.includes(e.model) ? phones.modelSpec(e.model) : null;
    if (spec && spec.lineKeys > 0 && e.keys.length > spec.lineKeys) {
      out.push(id + ': ' + spec.label + ' has ' + spec.lineKeys + ' key(s); ' + e.keys.length + ' are set');
    }
    e.keys.forEach((k, i) => {
      if (k.type !== 'blf' && k.type !== 'speed') out.push(id + ': button ' + (i + 1) + ' type must be blf or speed');
      if (!EXT_RE.test(k.ext)) out.push(id + ': button ' + (i + 1) + ' needs a 4-digit extension');
      if (k.ext === e.ext) out.push(id + ': button ' + (i + 1) + ' points at itself');
    });
  }
  for (const e of dir.extensions) {
    e.keys.forEach((k, i) => { if (EXT_RE.test(k.ext) && !seenExt.has(k.ext)) out.push(e.ext + ': button ' + (i + 1) + ' points at unknown extension ' + k.ext); });
  }
  return out;
}

function nextFreeExt(dir, deptName) {
  const used = new Set((dir.extensions || []).map(e => e.ext));
  const d = (dir.departments || []).find(x => x.name === deptName);
  let lo = 1000, hi = 8999;
  if (d && Number.isInteger(d.from)) { lo = d.from; hi = d.to; }
  for (let n = lo; n <= hi; n++) { const s = String(n); if (!used.has(s)) return s; }
  return null;
}

// Idempotent: a normalized directory normalizes to itself.
function normalizeDirectory(dir) {
  dir = dir || {};
  return {
    version: Number.isInteger(dir.version) ? dir.version : 0,
    updatedAt: dir.updatedAt || null,
    updatedBy: dir.updatedBy || null,
    site: dir.site || 'PMC',
    note: dir.note || undefined,
    departments: (Array.isArray(dir.departments) ? dir.departments : []).map(normalizeDepartment),
    extensions: (Array.isArray(dir.extensions) ? dir.extensions : []).map(normalizeExtension)
  };
}

module.exports = { normalizeExtension, normalizeDepartment, normalizeDirectory, validateDirectory, nextFreeExt, MODELS, SITES, EXT_RE, MAC_RE };
