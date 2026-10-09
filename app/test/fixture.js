'use strict';
/*
 * The directory the tests run against. Deliberately NOT app/sample/directory.json.
 *
 * The sample is a showcase: it changes whenever the real fleet changes, and on 9 Oct 2026 editing it to show
 * the pilot's mixed handsets broke three tests that had hard-coded its counts. A test fixture is owned by the
 * tests and changes only when a test wants it to.
 *
 * Small on purpose: two Yealink T31P with a button each, and one number with no handset.
 */

const fs = require('fs');
const path = require('path');

const DIRECTORY = {
  version: 0,
  site: 'PMC',
  note: 'TEST FIXTURE. Not the sample, not real people, not real phones.',
  departments: [
    { name: 'Nursing', from: 1000, to: 1999 },
    { name: 'Clinical', from: 2000, to: 2999 },
    { name: 'Administration', from: 3000, to: 3899 },
    { name: 'ICT', from: 3900, to: 3999 },
    { name: 'Doctors', from: 4000, to: 4999 },
    { name: 'JRBY', from: 5000, to: 5999 }
  ],
  extensions: [
    { ext: '3901', name: 'ICT Test Phone A', dept: 'ICT', site: 'PMC', model: 'T31P', mac: '001565aaaa01', voicemail: true,
      keys: [{ type: 'blf', ext: '3902' }] },
    { ext: '3902', name: 'ICT Test Phone B', dept: 'ICT', site: 'PMC', model: 'T31P', mac: '001565aaaa02', voicemail: true,
      keys: [{ type: 'blf', ext: '3901' }] },
    { ext: '1101', name: 'Nurse Station 1', dept: 'Nursing', site: 'PMC', model: 'T31P', mac: '', voicemail: false,
      keys: [{ type: 'blf', ext: '3901', label: 'ICT' }] }
  ]
};

// The config the tests use: the sample's, which is a plain file and safe to read.
function config() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample', 'config.json'), 'utf8'));
}

const directory = () => JSON.parse(JSON.stringify(DIRECTORY));

module.exports = { directory, config, DIRECTORY };
