#!/usr/bin/env node
'use strict';
// Stands in for `asterisk -rx "<command>"` in tests. Endpoints come from the generated pjsip file named by
// FAKE_PJSIP_FILE, so a test can see that an Apply really reached "the engine". FAKE_DOWN=1 simulates an
// engine that is not running; FAKE_FAIL_RELOAD=1 makes reloads fail.
const fs = require('fs');
const i = process.argv.indexOf('-rx');
const cmd = i >= 0 ? process.argv[i + 1] : '';

if (process.env.FAKE_DOWN) { process.stderr.write('Unable to connect to remote asterisk (does /var/run/asterisk/asterisk.ctl exist?)\n'); process.exit(1); }

function exts() {
  if (process.env.FAKE_STALE) return ['1101', '3901', '3902']; // an engine that kept its old config after a reload
  try { return Array.from(fs.readFileSync(process.env.FAKE_PJSIP_FILE || '', 'utf8').matchAll(/^\[(\d{4})\]\(pmc-endpoint\)/gm)).map(m => m[1]); }
  catch (e) { return []; }
}

switch (cmd) {
  case 'core show version':
    console.log('Asterisk 22.11.0 (fake) built by test @ test on a x86_64 running Linux');
    break;
  case 'pjsip show endpoints': {
    const e = exts();
    console.log('');
    console.log(' Endpoint:  <Endpoint/CID.....................................>  <State.....>  <Channels.>');
    for (const x of e) console.log(' Endpoint:  ' + x + '/' + x + '                                            ' + (x === '3901' ? 'Not in use' : 'Unavailable') + '   0 of 1');
    console.log('');
    console.log('Objects found: ' + e.length);
    break;
  }
  case 'pjsip show contacts':
    console.log('');
    console.log('  Contact:  3901/sip:3901@10.2.1.55:5061;transport=tls         1a2b3c4d5e Avail        12.345');
    console.log('');
    console.log('Objects found: 1');
    break;
  case 'core show channels count':
    console.log('0 active channels');
    console.log('0 active calls');
    console.log('3 calls processed');
    break;
  case 'pjsip reload':
    if (process.env.FAKE_FAIL_RELOAD) { console.log('No such command'); process.exit(1); }
    break;
  case 'dialplan reload':
    console.log('Dialplan reloaded.');
    break;
  case 'dialplan show pmc-internal': {
    console.log("[ Context 'pmc-internal' created by 'pbx_config' ]");
    for (const x of exts()) console.log("  '" + x + "' =>         hint: PJSIP/" + x + "                              [extensions_pmc.conf:20]");
    console.log("  '9196' =>         1. Answer()                                   [extensions_pmc.conf:10]");
    break;
  }
  default:
    console.log("No such command '" + cmd + "'");
    process.exit(1);
}
