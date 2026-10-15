'use strict';
/*
 * The phone registry. One driver per vendor; a model belongs to exactly one driver.
 *
 * Dada, 9 Oct 2026: "we should be able to provision multiple types of phones anyway". Vendors do not agree on
 * the shape of provisioning, so a driver declares its own:
 *
 *   perPhoneFile(e, ctx)      one file for that handset, fetched with that handset's own password (Yealink)
 *   sharedFiles(phones, ctx)  files every phone of this vendor fetches (Avaya's 46xxsettings.txt; Yealink's
 *                             phonebook). A shared file must never carry a per-phone secret
 *   auth                      'per-mac', 'shared' (any handset's own password) or 'lan' (no password, provNetworks
 *                             only, for handsets that cannot send one): how the provisioning listener guards them
 *   models                    model id -> { label, accounts, lineKeys, blf }
 *   setupNotes(e)             what an engineer types at the handset the first time
 *
 * Adding a vendor is a new file here plus one line in DRIVERS. Nothing else in the application changes.
 */

const DRIVERS = [
  require('./yealink'),
  require('./avaya'),
  require('./softphone')
];

const byModel = new Map();
for (const d of DRIVERS) for (const m of Object.keys(d.models)) byModel.set(m, d);

const driverFor = model => byModel.get(model) || null;
const modelIds = () => Array.from(byModel.keys());
const modelLabels = () => {
  const out = {};
  for (const d of DRIVERS) for (const [m, spec] of Object.entries(d.models)) out[m] = spec.label;
  return out;
};
const modelSpec = model => {
  const d = driverFor(model);
  return d ? Object.assign({ driver: d.id, vendor: d.vendor }, d.models[model]) : null;
};
const supportsKeys = model => { const s = modelSpec(model); return !!(s && s.blf && s.lineKeys > 0); };

module.exports = { DRIVERS, driverFor, modelIds, modelLabels, modelSpec, supportsKeys };
