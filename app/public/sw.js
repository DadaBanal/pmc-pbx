'use strict';
// PMC Phone as an installed app (13 Oct 2026). This worker caches nothing: a phone that runs yesterday's sip.js is
// worse than one that says it cannot reach the server. It only turns a failed page load into a plain message.
const OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>PMC Phone</title><body style="margin:0;background:#080b14;color:#eef1f8;font:15px/1.5 system-ui,sans-serif;'
  + 'display:grid;place-items:center;min-height:100vh;text-align:center"><div><h1 style="font-size:20px">PMC Phone cannot reach the phone system</h1>'
  + '<p>Check that this device is on the hospital network, then try again.</p>'
  + '<button onclick="location.reload()" style="font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#8ea2ff;color:#0b1020">Try again</button></div>';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return; // API calls, scripts and the call itself go straight to the network
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
