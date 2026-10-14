'use strict';
// The call relay (TURN). WS47, 14 Oct 2026, Dada: "do the call relay now"; earlier: "should be low on bandwidth",
// "have no issues with lag or connections", "work as long as there is an internet connection but no backdoors".
//
// A phone on a network that blocks a call's audio (UDP) can still carry it: over TLS on 443, or TCP/UDP 3478, to coturn
// on PMC-PBX01's relay address (10.2.0.12, public 103.144.157.236), which hands the audio to the engine on the LAN and
// to nothing else (its own peer rules, and the host firewall pinning user turnserver to 10.2.0.11 udp 10000-10999).
// Calls that can go direct still go direct: the browser prefers its own and the engine's candidates over a relay.
//
// Credentials are coturn's "REST API" kind (use-auth-secret / static-auth-secret): username "<expiry unix time>:<ext>",
// password base64(HMAC-SHA1(shared secret, username)). Nothing is stored per user and each one stops at its expiry.
const crypto = require('crypto');

// secrets.turn, created on Apply when config.json names a relay. vm/coturn gives the same value to coturn.
function ensureSecret(cfg, secrets) {
  if (!cfg || !cfg.relay || secrets.turn) return 0;
  secrets.turn = crypto.randomBytes(32).toString('hex');
  return 1;
}

function credential(secret, username) { return crypto.createHmac('sha1', secret).update(username).digest('base64'); }

// RTCPeerConnection iceServers for one phone; [] when no relay is configured, so the phone works exactly as before
function iceServers(cfg, secret, ext, nowMs) {
  if (!cfg || !cfg.relay || !secret) return [];
  const expiry = Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000) + cfg.relay.ttlSeconds;
  const username = expiry + ':' + String(ext).replace(/[^0-9A-Za-z._-]/g, '');
  const h = cfg.relay.host;
  // only the routes the gateway forwards: a route that never answers holds up every call while the browser waits on it
  const ROUTE = { udp: 'turn:' + h + ':3478?transport=udp', tcp: 'turn:' + h + ':3478?transport=tcp', tls: 'turns:' + h + ':443?transport=tcp' };
  return [{ urls: (cfg.relay.transports || ['udp', 'tcp', 'tls']).map(t => ROUTE[t]), username, credential: credential(secret, username) }];
}

module.exports = { ensureSecret, iceServers, credential };
