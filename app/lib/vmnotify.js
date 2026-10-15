'use strict';
/*
 * Voicemail notices to a Teams chat (Dada, 15 Oct 2026: "can we do a voicemail that goes to email projects@pmcne.ph or
 * sends to the pmo teams chitchat" ... "for now pmo chitchat").
 *
 * An app cannot post into a Teams group chat by itself: Graph allows application permission there for migration only
 * (Microsoft Learn, "Send message in a chat"). The supported way in is a Teams Workflow, "When a Teams webhook request
 * is received" -> post a card in a chat, which gives an HTTPS address. This module watches the voicemail store and
 * posts one Adaptive Card per new message to that address ({"type":"message","attachments":[...]}, Microsoft Learn,
 * "Send Adaptive Cards using an Incoming Webhook"). The card says who left it, for whom, when and how long; it never
 * carries the recording. Listening stays on the phone (*97).
 *
 * Config voicemailNotify: { departments: ["PMO"], extensions: [], intervalSec: 15, spoolDir }.
 * The address is a secret (anyone holding it can post into the chat): secrets.json voicemailWebhook.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const SPOOL = '/var/spool/asterisk/voicemail/pmc';

// Asterisk's msgNNNN.txt: "key=value" lines under [message]
function parseMessage(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function caller(callerid) {
  const m = /^"?([^"<]*)"?\s*<([^>]*)>$/.exec(String(callerid || '').trim());
  if (!m) return String(callerid || 'Unknown caller');
  const name = m[1].trim(), num = m[2].trim();
  return name && name !== num ? name + ' (' + num + ')' : num || 'Unknown caller';
}

function length(sec) {
  const s = Math.max(0, parseInt(sec, 10) || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function when(epoch) {
  const d = new Date((parseInt(epoch, 10) || 0) * 1000);
  return d.toLocaleString('en-PH', { timeZone: 'Asia/Manila', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function card(msg, ext, name) {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: 'New voicemail for ' + ext + (name ? ' ' + name : ''), weight: 'Bolder', size: 'Medium', wrap: true },
          { type: 'FactSet', facts: [
            { title: 'From', value: caller(msg.callerid) },
            { title: 'Received', value: when(msg.origtime) },
            { title: 'Length', value: length(msg.duration) }
          ] },
          { type: 'TextBlock', text: 'Dial *97 from ' + ext + ' to listen.', isSubtle: true, wrap: true }
        ]
      }
    }]
  };
}

// which mailboxes are watched: the named departments plus any listed extensions, that exist
function watched(dir, opts) {
  const deps = new Set((opts.departments || []).map(String));
  const extra = new Set((opts.extensions || []).map(String));
  return dir.extensions.filter(e => deps.has(e.dept) || extra.has(e.ext));
}

function httpsPost(url, body) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, status: 0, error: 'bad address' }); }
    if (u.protocol !== 'https:') return resolve({ ok: false, status: 0, error: 'not https' });
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(u, { method: 'POST', timeout: 15000, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.end(data);
  });
}

/*
 * deps: { loadDirectory(), getSecrets(), log(line), post(url, body) -> {ok,status} }
 * State (seen msg_ids) lives in <dataDir>/vmnotify-state.json so a restart never posts twice. The first pass only
 * records what is already there: switching this on does not flood the chat with old messages.
 */
function createNotifier(cfg, deps) {
  const opts = Object.assign({ departments: [], extensions: [], intervalSec: 15, spoolDir: SPOOL }, cfg.voicemailNotify || {});
  const stateFile = path.join(cfg.dataDir, 'vmnotify-state.json');
  const post = deps.post || httpsPost;
  const log = deps.log || (() => {});
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { state = { primed: false, seen: [] }; }
  const seen = new Set(state.seen || []);
  const save = () => {
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ primed: true, seen: [...seen].slice(-5000) }));
    fs.renameSync(tmp, stateFile);
  };
  let busy = false;

  async function tick() {
    if (busy) return { posted: 0 };
    busy = true;
    let posted = 0;
    try {
      const url = (deps.getSecrets() || {}).voicemailWebhook;
      const boxes = watched(deps.loadDirectory(), opts);
      const fresh = [];
      for (const e of boxes) {
        const inbox = path.join(opts.spoolDir, e.ext, 'INBOX');
        let files = [];
        try { files = fs.readdirSync(inbox).filter(f => /^msg\d+\.txt$/.test(f)).sort(); } catch (err) { continue; }
        for (const f of files) {
          let msg;
          try { msg = parseMessage(fs.readFileSync(path.join(inbox, f), 'utf8')); } catch (err) { continue; }
          const id = msg.msg_id || (e.ext + '/' + f + '/' + msg.origtime);
          if (!seen.has(id)) fresh.push({ id, msg, e });
        }
      }
      if (!state.primed) {
        fresh.forEach(x => seen.add(x.id));
        state.primed = true; save();
        log('voicemail notices: started; ' + fresh.length + ' existing message(s) marked as already seen');
        return { posted: 0, primed: fresh.length };
      }
      if (!fresh.length) return { posted: 0 };
      if (!url) { log('voicemail notices: ' + fresh.length + ' new, but no voicemailWebhook is set'); return { posted: 0 }; }
      for (const x of fresh) {
        const r = await post(url, card(x.msg, x.e.ext, x.e.name));
        if (r && r.ok) { seen.add(x.id); posted++; log('voicemail notice posted for ' + x.e.ext + ' (' + x.id + ')'); }
        else log('voicemail notice for ' + x.e.ext + ' failed (' + (r && (r.status || r.error)) + '), will retry');
      }
      if (posted) save();
      return { posted };
    } finally { busy = false; }
  }

  let timer = null;
  return {
    tick,
    start() { timer = setInterval(() => { tick().catch(err => log('voicemail notices: ' + err.message)); }, opts.intervalSec * 1000); if (timer.unref) timer.unref(); tick().catch(() => {}); return this; },
    stop() { if (timer) clearInterval(timer); }
  };
}

module.exports = { createNotifier, parseMessage, card, caller, length, watched, httpsPost };
