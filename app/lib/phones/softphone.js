'use strict';
/*
 * Software phones and anything with no desk handset. No file is generated and nothing is provisioned: the
 * person is given the server name, their extension and its password, and types them into whatever app they use.
 * It is a driver rather than a special case so the rest of the application never asks "is this a real phone".
 */

const MODELS = {
  softphone: { label: 'Software phone (app on a PC or mobile)', accounts: 1, lineKeys: 0, blf: false },
  none: { label: 'No phone yet', accounts: 1, lineKeys: 0, blf: false }
};

module.exports = {
  id: 'softphone',
  vendor: 'None',
  models: MODELS,
  auth: 'none',
  perPhoneFile: null,
  sharedFiles: () => [],
  setupNotes: e => ([
    'Server: ' + e.fqdn + ' port ' + e.sipPort + ', TLS, with SRTP on',
    'User name and authentication name: ' + e.ext,
    'Password: ' + (e.sipPassword || '(created at the next Apply)'),
    'Nothing is provisioned to a software phone; these three lines are the whole setup.'
  ])
};
