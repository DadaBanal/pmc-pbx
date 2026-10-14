'use strict';
/* PMC Phone - the browser phone screen. Plain JavaScript, no framework, the same shell, tokens and habits as the
   admin screen and the PSA desk. Signs in through /api/login, fetches only the signed-in person's own extension
   from /api/softphone, and talks SIP over /ws (sip.js). Media is a WebRTC RTCPeerConnection, one per call.

   What a modern handset does, since 14 Oct 2026 (Dada: "we need to add modern function call waiting call on hold
   etc whatever is missing", "three way calling conferenfce"): call waiting with hold-and-answer or end-and-answer,
   hold, add a call, swap, merge into a three-way call (the engine's conference room *88<ext>), transfer straight
   away or after talking first, a choice of speaker where the browser allows one, do not disturb, voicemail.
   A menu on top (Dada: "why not just add a menu on top for phonebook and quick dial", "also regarding the onhold
   call"): Keypad (Call while one is up), Quick dial, Phone book, Recent - one screen at a time on a phone - and the
   call you are on or holding stays in a bar on every screen, one tap from the controls.

   Keyboard: digits, * and # dial (or send tones on a call); Enter calls; Escape hangs up, declines or goes back;
   / jumps to the phone book search; t switches light and dark. */
(function () {
  const d = document, root = d.documentElement;
  const $ = (s, c) => (c || d).querySelector(s);
  const $$ = (s, c) => Array.prototype.slice.call((c || d).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = n => '<svg class="ic" aria-hidden="true"><use href="#i-' + n + '"></use></svg>';
  const clean = n => String(n || '').replace(/[^0-9*#+]/g, '');

  // ------------------------------------------------------------------ preferences kept in this browser
  const THEME = 'pmc-phones-theme', RECENT = 'pmc-phone-recent', DND = 'pmc-phone-dnd', OUT = 'pmc-phone-output';
  const store = { get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };
  const applyTheme = () => { root.dataset.theme = store.get(THEME) || 'dark'; };
  const toggleTheme = () => { store.set(THEME, root.dataset.theme === 'dark' ? 'light' : 'dark'); applyTheme(); };
  applyTheme();

  const S = { me: null, creds: null, book: [], ua: null, query: '', number: '', xfer: '', mode: null, padOpen: false, timer: null, tones: null, toneKind: '', tab: 'keypad', listTab: '',
    ringing: null, focus: null, busy: false, dnd: store.get(DND) === '1', outs: [], sink: store.get(OUT) };

  async function api(method, path, body) {
    const opt = { method, headers: { 'X-PMC-PBX': '1' }, credentials: 'same-origin' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(path, opt);
    let data = null; try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) { const err = new Error((data && data.error) || 'request failed (' + r.status + ')'); err.status = r.status; throw err; }
    return data;
  }
  const say = (t, urgent) => { const el = $(urgent ? '#alert' : '#say'); el.textContent = ''; setTimeout(() => { el.textContent = t; }, 30); };
  function toast(msg, kind) {
    $$('.banner.toast').forEach(t => t.remove());
    const t = d.createElement('div'); t.className = 'banner toast ' + (kind === 'bad' ? 'err' : kind || '');
    t.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
    t.innerHTML = esc(msg) + '<button class="iconbtn x" type="button" aria-label="Close">' + icon('x') + '</button>';
    d.body.appendChild(t); $('.x', t).onclick = () => t.remove();
    setTimeout(() => t.remove(), kind === 'bad' ? 9000 : 4000);
  }

  // ------------------------------------------------------------------ tones, made here: no sound files to fetch
  let ac = null;
  const TONES = {
    ring: { freqs: [660, 880], on: 0.4, gap: 0.2, bursts: 2, every: 3, level: 0.12 },       // two short warbles every 3 s
    ringback: { freqs: [440, 480], on: 2, gap: 0, bursts: 1, every: 6, level: 0.06 },       // what a caller hears
    waiting: { freqs: [440], on: 0.25, gap: 0.15, bursts: 2, every: 5, level: 0.05 }         // call waiting: soft, in your ear
  };
  function tones(kind) {
    stopTones();
    try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    if (ac.state === 'suspended') ac.resume();
    const plan = TONES[kind];
    const gain = ac.createGain(); gain.gain.value = 0; gain.connect(ac.destination);
    const oscs = plan.freqs.map(f => { const o = ac.createOscillator(); o.frequency.value = f; o.connect(gain); o.start(); return o; });
    const schedule = () => {
      const t0 = ac.currentTime + 0.05;
      for (let b = 0; b < plan.bursts; b++) {
        const s = t0 + b * (plan.on + plan.gap);
        gain.gain.setValueAtTime(plan.level, s); gain.gain.setValueAtTime(0, s + plan.on);
      }
    };
    schedule();
    const iv = setInterval(schedule, plan.every * 1000);
    S.toneKind = kind;
    S.tones = () => { clearInterval(iv); try { gain.gain.cancelScheduledValues(0); gain.gain.value = 0; oscs.forEach(o => o.stop()); gain.disconnect(); } catch (e) { /* closed */ } };
  }
  function stopTones() { if (S.tones) { S.tones(); S.tones = null; S.toneKind = ''; } }
  // one rule for every tone: a ringing incoming call rings (softly, as call waiting, if you are talking on another);
  // otherwise an outgoing call that is ringing gives ringback; otherwise silence
  function syncTones() {
    const t = talking();
    const want = ringingIn().length ? (t.some(c => c.state === 'active' && !parked(c)) ? 'waiting' : 'ring')
      : t.some(c => c.dir === 'out' && c.state === 'ringing') ? 'ringback' : '';
    if (want !== S.toneKind) { if (want) tones(want); else stopTones(); }
  }

  // ------------------------------------------------------------------ where the call is heard
  // A web page can choose the speaker only where the browser has HTMLMediaElement.setSinkId: desktop browsers, and
  // Safari from 18.4. Chrome and Firefox on Android do not, because of an Android limit (MDN browser-compat-data;
  // crbug 41276355, closed: "unlikely to change anytime soon"), so there the phone decides and it picks the
  // loudspeaker. Measured 14 Oct 2026; the screen says so plainly rather than offering a button that does nothing.
  const CAN_PICK = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  const TOUCH = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  async function refreshOutputs() {
    if (!CAN_PICK || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return false;
    const before = S.outs.map(o => o.id + o.label).join('|');
    try {
      S.outs = (await navigator.mediaDevices.enumerateDevices())
        .filter(x => x.kind === 'audiooutput' && x.deviceId && x.deviceId !== 'communications')
        .map(x => ({ id: x.deviceId, label: (x.label || 'Speaker').replace(/^Default - /, 'Default: ') }));
    } catch (e) { S.outs = []; }
    if (S.sink && !S.outs.some(o => o.id === S.sink)) S.sink = '';
    return before !== S.outs.map(o => o.id + o.label).join('|');
  }
  const canChoose = () => CAN_PICK && S.outs.length > 1;
  function applySink() { $$('#audios audio').forEach(el => { if (el.setSinkId) el.setSinkId(S.sink || '').catch(() => {}); }); }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => { refreshOutputs().then(ch => { if (ch) { applySink(); drawCallZone(); } }); });
  }

  // ------------------------------------------------------------------ media: one RTCPeerConnection and one <audio> per call
  function browserMedia(holder) {
    return {
      async create() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('this browser cannot use a microphone on this page');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
        stream.getTracks().forEach(t => pc.addTrack(t, stream));
        // its own element: with two calls up, ending one must not silence the other (before 14 Oct one element served all)
        const el = d.createElement('audio'); el.autoplay = true; el.setAttribute('playsinline', ''); holder.appendChild(el);
        if (CAN_PICK && S.sink) el.setSinkId(S.sink).catch(() => {});
        pc.ontrack = ev => { el.srcObject = ev.streams[0] || new MediaStream([ev.track]); const p = el.play(); if (p && p.catch) p.catch(() => {}); };
        refreshOutputs().then(ch => { if (ch) drawCallZone(); }); // names are readable once the microphone is allowed
        const gathered = () => new Promise(resolve => {
          if (pc.iceGatheringState === 'complete') return resolve();
          const t = setTimeout(resolve, 2500);
          pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
        });
        return {
          async offer() { await pc.setLocalDescription(await pc.createOffer()); await gathered(); return pc.localDescription.sdp; },
          async setAnswer(sdp) { await pc.setRemoteDescription({ type: 'answer', sdp }); },
          async answerOffer(sdp) { await pc.setRemoteDescription({ type: 'offer', sdp }); await pc.setLocalDescription(await pc.createAnswer()); await gathered(); return pc.localDescription.sdp; },
          setDirection(dir) { pc.getTransceivers().forEach(t => { t.direction = dir; }); },
          mute(on) { stream.getAudioTracks().forEach(t => { t.enabled = !on; }); },
          dtmf(digit) { const s = pc.getSenders().find(x => x.dtmf); if (s && s.dtmf.canInsertDTMF !== false) s.dtmf.insertDTMF(digit, 120, 70); },
          close() { stream.getTracks().forEach(t => t.stop()); try { pc.close(); } catch (e) { /* closed */ } el.srcObject = null; el.remove(); }
        };
      }
    };
  }

  // ------------------------------------------------------------------ calls, as the screen sees them
  const live = () => (S.ua ? Array.from(S.ua.calls.values()) : []).filter(c => c.state !== 'ended');
  const ringingIn = () => live().filter(c => c.dir === 'in' && c.state === 'ringing');
  const talking = () => live().filter(c => !(c.dir === 'in' && c.state === 'ringing'));
  const room = () => '*88' + (S.creds ? S.creds.ext : '');
  const isConf = c => !!c && c.number === room();
  const parked = c => c.held || c.asideOn;
  // the call the big panel shows: the one you are talking on, else the one being dialled, else the latest
  function focusCall() {
    const t = talking();
    return t.find(c => c.state === 'active' && !parked(c)) || t.find(c => c.state !== 'active') || t[t.length - 1] || null;
  }
  // hold, except a conference: holding it would play hold music to everyone in it, so it is muted instead
  async function park(c) { if (isConf(c)) c.aside(true); else await c.hold(true); }
  async function unpark(c) { if (isConf(c)) c.aside(false); else await c.hold(false); }

  // ------------------------------------------------------------------ quick dial: the people this person starred, kept per extension
  const QUICK = () => 'pmc-phone-quick-' + (S.creds ? S.creds.ext : '');
  const quick = () => { try { const q = JSON.parse(store.get(QUICK()) || '[]'); return Array.isArray(q) ? q.filter(x => typeof x === 'string') : []; } catch (e) { return []; } };
  function toggleQuick(ext) {
    const q = quick();
    const on = !q.includes(ext);
    store.set(QUICK(), JSON.stringify(on ? q.concat(ext).slice(-30) : q.filter(x => x !== ext)));
    say((nameFor(ext) || ext) + (on ? ' added to' : ' removed from') + ' quick dial.');
    drawQuick(); drawBook();
  }

  // ------------------------------------------------------------------ the menu on top
  // A phone shows one screen at a time; a wide screen keeps the keypad on the left and switches the right column.
  const NARROW = window.matchMedia ? matchMedia('(max-width: 820px)') : { matches: false };
  function setTab(t) { S.tab = t; if (t !== 'keypad') S.listTab = t; applyTab(); }
  function applyTab() {
    if (!$('#p-keypad')) return;
    const wide = !NARROW.matches;
    const t = wide && S.tab === 'keypad' ? (S.listTab || 'quick') : S.tab;
    $('#t-keypad').classList.toggle('hidden', wide);
    $('#p-keypad').classList.toggle('hidden', !wide && t !== 'keypad');
    $('#lists').classList.toggle('hidden', !wide && t === 'keypad');
    for (const k of ['keypad', 'quick', 'book', 'recent']) {
      const b = $('#t-' + k), on = k === t;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      if (k !== 'keypad') $('#p-' + k).classList.toggle('hidden', !on);
    }
    drawCallBar();
  }
  if (NARROW.addEventListener) NARROW.addEventListener('change', applyTab);
  // the call you are on, or holding, on every screen: tap it to get back to the controls
  function drawCallBar() {
    const bar = $('#callbar');
    if (!bar) return;
    const calls = talking();
    const kp = $('#t-keypad');
    if (kp) { $('span', kp).textContent = calls.length ? 'Call' : 'Keypad'; kp.classList.toggle('live', calls.length > 0); }
    const show = calls.length > 0 && NARROW.matches && S.tab !== 'keypad';
    bar.classList.toggle('hidden', !show);
    if (!show) { bar.innerHTML = ''; return; }
    const allHeld = calls.every(parked);
    bar.className = 'callbar' + (allHeld ? ' held' : '');
    bar.innerHTML = '<span class="cb-calls">' + calls.map(c => '<span class="cb-item"><span class="dot"></span>' + esc(parked(c) ? (c.asideOn ? 'Muted: ' : 'On hold: ') : c.state === 'active' ? 'On call: ' : 'Calling: ') + '<b>' + esc(label(c)) + '</b></span>').join('') +
      '</span><span class="cb-go">' + (allHeld ? 'Resume' : 'Back to the call') + '</span>';
  }

  // ------------------------------------------------------------------ the recent calls this browser keeps
  const recent = () => { try { return JSON.parse(store.get(RECENT) || '[]'); } catch (e) { return []; } };
  function keep(entry) { const list = recent(); list.unshift(entry); store.set(RECENT, JSON.stringify(list.slice(0, 25))); }
  function remember(c) {
    if (isConf(c)) return;
    keep({ dir: c.dir, number: c.number, name: c.name || nameFor(c.number), at: c.startedAt || c.endedAt || Date.now(),
      secs: c.startedAt ? Math.round(((c.endedAt || Date.now()) - c.startedAt) / 1000) : 0, result: c.startedAt ? 'answered' : (c.reason || 'missed') });
  }
  const SPECIAL = { 9196: 'Echo test', 9197: 'Test message', '*97': 'Voicemail' };
  const nameFor = n => { if (!n) return ''; if (S.creds && n === room()) return 'Conference call'; if (SPECIAL[n]) return SPECIAL[n]; const e = S.book.find(x => x.ext === n); return e ? e.name : ''; };
  const label = c => (c ? (c.name || nameFor(c.number) || c.number || 'Unknown caller') : '');
  const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dur = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

  // ------------------------------------------------------------------ status
  const STATUS = {
    connecting: ['warn', 'Connecting'], registered: ['ok', 'Ready'], offline: ['bad', 'Offline, trying again'],
    denied: ['bad', 'Phone not accepted'], failed: ['bad', 'Phone not accepted']
  };
  function showStatus(state, why) {
    let [cls, text] = STATUS[state] || ['warn', state];
    if (state === 'registered' && S.dnd) { cls = 'warn'; text = 'Do not disturb'; }
    const el = $('#status'); el.className = 'chip ' + cls;
    $('#status-text').textContent = text;
    el.title = why && why !== 'say' ? why : '';
    if (why === 'say') {
      if (state === 'registered') say(S.dnd ? 'Your phone is ready. Do not disturb is on: calls go to your voicemail.' : 'Your phone is ready. Calls to ' + S.creds.ext + ' ring here.');
    }
    if (state === 'denied') { say('The phone system did not accept this phone. Ask PMO ICT.', true); toast('The phone system did not accept this phone\'s password. Ask PMO ICT to check extension ' + S.creds.ext + '.', 'bad'); }
  }

  // ------------------------------------------------------------------ sign in
  function renderLogin(message) {
    $('#who').innerHTML = '';
    showStatusPlain('Signed out', 'warn');
    $('#main').innerHTML = '<div class="login"><div class="card"><h2>Sign in to your phone</h2><p class="sub">Use your Windows name and password, the ones you use to sign in to a hospital PC. Calls to your extension will ring here.</p>' +
      (message ? '<div class="banner err" role="alert">' + esc(message) + '</div>' : '') +
      '<form id="login"><div><label for="ln">Name</label><input id="ln" name="name" autocomplete="username" required autofocus></div>' +
      '<div><label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password" required></div>' +
      '<button class="primary" type="submit">Sign in</button></form></div></div>';
    $('#login').onsubmit = async ev => {
      ev.preventDefault(); const f = ev.target; const b = $('button', f); b.disabled = true; b.setAttribute('aria-busy', 'true');
      try { await api('POST', '/api/login', { name: f.name.value, password: f.password.value }); await boot(); }
      catch (e) { b.disabled = false; b.removeAttribute('aria-busy'); toast(e.status === 401 ? 'That name and password do not match. Check them and try again.' : e.message, 'bad'); }
    };
  }
  function showStatusPlain(text, cls) { $('#status').className = 'chip ' + cls; $('#status-text').textContent = text; }

  // ------------------------------------------------------------------ the phone
  const PAD = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
  function signOut(ev) {
    ev.preventDefault();
    (async () => {
      if (S.ua) await S.ua.stop();
      store.set(RECENT, '[]'); store.set(DND, ''); // the next person on this browser starts clean
      try { await api('POST', '/api/logout'); } catch (e) { /* already out */ }
      location.reload();
    })();
  }
  function renderPhone() {
    const c = S.creds;
    $('#who').innerHTML = '<span class="name">' + esc(c.name) + '</span><span class="sep">&middot;</span><span class="muted mono">' + esc(c.ext) + '</span>' +
      '<span class="sep">&middot;</span><button type="button" class="iconbtn" id="theme" aria-label="Switch light or dark" title="Light or dark (t)">' + icon('sun') + '</button>' +
      '<span class="sep">&middot;</span><a href="#" id="out">Sign out</a>';
    $('#theme').onclick = toggleTheme;
    $('#out').onclick = signOut;
    const tab = (id, ic, text) => '<button type="button" role="tab" class="tab" id="t-' + id + '" aria-controls="p-' + id + '" aria-selected="false" tabindex="-1">' + icon(ic) + '<span>' + text + '</span></button>';
    $('#main').innerHTML =
      '<div class="phone-grid">' +
      '<nav class="tabs" role="tablist" aria-label="Phone">' + tab('keypad', 'grid', 'Keypad') + tab('quick', 'star', 'Quick dial') + tab('book', 'users', 'Phone book') + tab('recent', 'clock', 'Recent') + '</nav>' +
      '<button type="button" class="callbar hidden" id="callbar"></button>' +
      '<section class="card dialer" id="p-keypad" role="tabpanel" aria-labelledby="dial-h"><h3 id="dial-h">' + icon('phone') + 'Your phone, ' + esc(c.ext) + '</h3>' +
      '<p class="sub">' + esc(c.name) + (c.dept ? ' &middot; ' + esc(c.dept) : '') + '</p>' +
      '<div id="callzone"></div></section>' +
      '<section class="card book lists" id="lists">' +
      '<div id="p-quick" role="tabpanel" aria-labelledby="t-quick"><h3>' + icon('star') + 'Quick dial</h3><div class="quick" id="quick"></div></div>' +
      '<div id="p-book" role="tabpanel" aria-labelledby="t-book"><h3 id="book-h">' + icon('users') + 'Phone book</h3>' +
      '<label class="sr-only" for="q">Search the phone book</label><div class="search">' + icon('search') + '<input id="q" type="search" placeholder="Name, department or number" autocomplete="off"></div>' +
      '<ul class="book-list" id="book" aria-label="People"></ul></div>' +
      '<div id="p-recent" role="tabpanel" aria-labelledby="t-recent"><h3 id="rec-h">' + icon('clock') + 'Recent</h3><ul class="book-list recent" id="recent" aria-labelledby="rec-h"></ul></div>' +
      '</section></div>';
    $('#q').oninput = () => { S.query = $('#q').value; drawBook(); };
    const order = ['keypad', 'quick', 'book', 'recent'];
    $$('.tabs .tab').forEach(b => {
      b.onclick = () => setTab(b.id.slice(2));
      b.onkeydown = ev => { // the tabs pattern: arrows move along the menu
        if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
        ev.preventDefault();
        const vis = order.filter(k => !$('#t-' + k).classList.contains('hidden'));
        const i = vis.indexOf(b.id.slice(2));
        const next = vis[(i + (ev.key === 'ArrowRight' ? 1 : -1) + vis.length) % vis.length];
        setTab(next); $('#t-' + next).focus();
      };
    });
    $('#callbar').onclick = () => {
      const calls = talking();
      setTab('keypad');
      if (calls.length && calls.every(parked)) { const f = calls[calls.length - 1]; run(() => unpark(f), 'Could not resume the call.'); }
    };
    S.listTab = quick().length ? 'quick' : 'book';
    drawBook(); drawQuick(); drawRecent(); drawCallZone(); applyTab();
  }

  const padHtml = id => '<div class="pad" id="' + id + '" role="group" aria-label="' + (id === 'dtmf' ? 'Keypad for menus' : 'Dial pad') + '">' +
    PAD.map(([k, s]) => '<button type="button" data-k="' + k + '" aria-label="' + (k === '*' ? 'star' : k === '#' ? 'hash' : k) + '"><b>' + k + '</b><small>' + (s || '&nbsp;') + '</small></button>').join('') + '</div>';

  let drawCallZone = function () {
    const z = $('#callzone');
    if (!z) return;
    const calls = talking();
    const f = focusCall();
    S.focus = f;
    if (!calls.length || S.mode === 'add') { if (!calls.length) S.mode = null; return drawDialer(z, calls); }
    if (S.mode === 'transfer' && f && f.state === 'active' && !parked(f)) return drawTransfer(z, f);
    S.mode = null;
    drawInCall(z, f, calls);
  };

  // ---------------- no call, or adding one
  function drawDialer(z, calls) {
    const adding = S.mode === 'add' && calls.length > 0;
    const first = adding ? calls[0] : null;
    const ready = S.ua && S.ua.state === 'registered';
    z.innerHTML =
      (adding ? '<div class="modehead"><span>' + icon('plus') + 'Add a call. ' + esc(label(first)) + (isConf(first) ? ' stays connected, muted.' : ' goes on hold.') + '</span>' +
        '<button type="button" class="linkbtn" id="back">Back to the call</button></div>' : '') +
      '<div class="numbox"><label class="sr-only" for="num">Number to call</label><input id="num" class="num mono" inputmode="tel" autocomplete="off" placeholder="Number" value="' + esc(S.number) + '">' +
      '<button type="button" class="iconbtn" id="bk" aria-label="Delete last digit">' + icon('back') + '</button></div>' +
      '<div class="numname" id="numname" aria-live="polite">' + esc(nameFor(S.number)) + '</div>' +
      padHtml('pad') +
      '<div class="callrow"><button type="button" class="callbtn" id="call"' + (ready ? '' : ' disabled') + '>' + icon('phone') + (adding ? 'Call and add' : 'Call') + '</button></div>' +
      (adding ? '<p class="hint">Type a number, or pick someone from the phone book.</p>' :
        '<div class="minirow"><button type="button" class="pill" id="vm">' + icon('voicemail') + 'Voicemail</button>' +
        '<button type="button" class="pill" id="dnd" role="switch" aria-checked="' + S.dnd + '">' + icon('moon') + 'Do not disturb</button></div>' +
        '<p class="hint">' + (S.dnd ? 'Do not disturb is on: your calls go to voicemail. Tap it again to turn it off.' :
          'Type or tap a number, or pick someone from the phone book. 9196 is an echo test: you hear yourself back.') + '</p>');
    const num = $('#num');
    const setNum = v => { S.number = v; num.value = v; $('#numname').textContent = nameFor(v); };
    num.oninput = () => { const v = clean(num.value); if (v !== num.value) num.value = v; S.number = v; $('#numname').textContent = nameFor(v); };
    num.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } };
    $('#bk').onclick = () => { setNum(S.number.slice(0, -1)); num.focus(); };
    const go = () => (adding ? addCall(S.number) : dial(S.number));
    $('#call').onclick = go;
    $$('#pad button').forEach(b => b.onclick = () => { setNum((S.number + b.dataset.k).slice(0, 24)); num.focus(); });
    if (adding) $('#back').onclick = () => { S.mode = null; drawCallZone(); };
    else {
      $('#vm').onclick = () => dial('*97');
      $('#dnd').onclick = () => {
        S.dnd = !S.dnd; store.set(DND, S.dnd ? '1' : '');
        if (S.ua) { S.ua.dnd = S.dnd; showStatus(S.ua.state); }
        say(S.dnd ? 'Do not disturb is on. Calls go to your voicemail.' : 'Do not disturb is off. Calls ring here.');
        drawCallZone(); const b = $('#dnd'); if (b) b.focus();
      };
    }
  }

  // ---------------- transfer: pick where the call goes
  function drawTransfer(z, f) {
    z.innerHTML =
      '<div class="modehead"><span>' + icon('transfer') + 'Transfer ' + esc(label(f)) + ' to</span><button type="button" class="linkbtn" id="back">Back to the call</button></div>' +
      '<div class="numbox"><label class="sr-only" for="xnum">Number to transfer to</label><input id="xnum" class="num mono" inputmode="tel" autocomplete="off" placeholder="Number" value="' + esc(S.xfer) + '"></div>' +
      '<div class="numname" id="xname" aria-live="polite">' + esc(nameFor(S.xfer)) + '</div>' +
      '<div class="xfer-actions"><button type="button" class="callbtn" id="x-ask">' + icon('phone') + 'Talk to them first</button>' +
      '<button type="button" class="ghost" id="x-now">' + icon('transfer') + 'Transfer now</button></div>' +
      '<p class="hint">Pick someone in the phone book or type their number. <b>Talk to them first</b> puts ' + esc(label(f)) +
      ' on hold and calls them; press Transfer when you are ready to connect them. <b>Transfer now</b> sends the call straight there.</p>';
    const x = $('#xnum');
    x.oninput = () => { const v = clean(x.value); if (v !== x.value) x.value = v; S.xfer = v; $('#xname').textContent = nameFor(v); };
    $('#back').onclick = () => { S.mode = null; drawCallZone(); };
    $('#x-ask').onclick = () => { if (!S.xfer) return toast('Type or pick a number first.', 'warn'); const n = S.xfer; S.mode = null; addCall(n); };
    $('#x-now').onclick = async () => {
      if (!S.xfer) return toast('Type or pick a number first.', 'warn');
      const n = S.xfer, who = nameFor(n) || n;
      S.busy = true; $('#x-now').setAttribute('aria-busy', 'true');
      const r = await f.transfer(n);
      S.busy = false; S.mode = null;
      if (r.ok) toast('Transferred ' + label(f) + ' to ' + who + '.', 'ok'); else toast('Could not transfer: ' + r.why + '. You are still on the call.', 'bad');
      drawCallZone();
    };
    x.focus();
  }
  function setXfer(n) { S.xfer = clean(n); const x = $('#xnum'); if (x) { x.value = S.xfer; x.focus(); } const t = $('#xname'); if (t) t.textContent = nameFor(S.xfer); }

  // ---------------- on a call
  function drawInCall(z, f, calls) {
    const other = calls.find(c => c !== f) || null;
    const ready = f.state === 'active';
    const busy = S.busy || calls.some(c => c.holding || c.referring);
    const btn = (id, ic, text, pressed, off) => '<button type="button" class="ctl" id="' + id + '"' + (pressed === undefined ? '' : ' aria-pressed="' + !!pressed + '"') + (off ? ' disabled' : '') + '>' + icon(ic) + text + '</button>';
    const stateText = c => ({ calling: 'Calling', ringing: c.dir === 'out' ? 'Ringing' : 'Incoming', connecting: 'Connecting',
      active: c.referring ? 'Transferring' : c.held ? 'On hold' : c.asideOn ? 'Muted while you talk' : isConf(c) ? 'Conference' : 'On call' }[c.state] || c.state);
    let ctl = [];
    if (ready && !parked(f)) {
      ctl.push(btn('mute', 'mic-off', f.muted ? 'Unmute' : 'Mute', f.muted), btn('kp', 'grid', 'Keypad', S.padOpen));
      if (!other) {
        if (!isConf(f)) ctl.push(btn('hold', 'pause', 'Hold', false, busy));
        ctl.push(btn('add', 'plus', isConf(f) ? 'Add person' : 'Add call', undefined, busy));
        if (!isConf(f)) ctl.push(btn('xfer', 'transfer', 'Transfer', undefined, busy));
      } else if (other.state === 'active') {
        ctl.push(btn('swap', 'swap', 'Swap', undefined, busy));
        if (!isConf(f) && !isConf(other)) ctl.push(btn('connect', 'transfer', 'Transfer', undefined, busy));
        ctl.push(btn('merge', 'merge', 'Merge', undefined, busy));
      }
    } else if (ready && parked(f)) {
      ctl.push(btn('resume', 'play', 'Resume', undefined, busy));
    }
    const out = ready && canChoose() ? '<label class="ctl out">' + icon('speaker') + '<span>Sound</span><select id="outsel" aria-label="Play the call on">' +
      S.outs.map(o => '<option value="' + esc(o.id) + '"' + ((S.sink ? o.id === S.sink : o.id === 'default') ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</select></label>' : '';
    const hints = [];
    if (ready && other && other.state === 'active' && !parked(f)) {
      hints.push(isConf(f) || isConf(other) ? 'Merge adds ' + esc(label(isConf(f) ? other : f)) + ' to the conference.' :
        '<b>Transfer</b> connects ' + esc(label(other)) + ' and ' + esc(label(f)) + ' and takes you off the call. <b>Merge</b> puts all three of you on one call.');
    }
    if (ready && TOUCH && !canChoose()) hints.push('This browser plays calls on the loudspeaker. Earphones or a headset keep a call private.');
    z.innerHTML =
      (other ? '<button type="button" class="otherline" id="olswap"' + (ready && other.state === 'active' && !busy ? '' : ' disabled') + ' aria-label="' + esc(stateText(other) + ': ' + label(other) + '. Switch to this call') + '">' +
        '<span class="ol-state">' + esc(stateText(other)) + '</span><b>' + esc(label(other)) + '</b>' +
        (other.number && other.number !== label(other) && !isConf(other) ? '<span class="mono muted">' + esc(other.number) + '</span>' : '') +
        (ready && other.state === 'active' ? '<span class="ol-go">' + icon('swap') + 'Switch</span>' : '') + '</button>' : '') +
      '<div class="oncall" aria-live="polite"><div class="oc-who">' + esc(label(f)) + '</div>' + (label(f) !== f.number && !isConf(f) ? '<div class="oc-num mono">' + esc(f.number) + '</div>' : '') +
      '<div class="oc-state' + (parked(f) ? ' held' : '') + '"><span class="dot"></span><span>' + esc(stateText(f)) + '</span> <span class="mono" id="clock"></span></div></div>' +
      (ctl.length || out ? '<div class="controls">' + ctl.join('') + out + '</div>' : '') +
      (ready && S.padOpen && !parked(f) ? padHtml('dtmf') : '') +
      hints.map(h => '<p class="hint">' + h + '</p>').join('') +
      '<div class="callrow"><button type="button" class="hangbtn" id="hang">' + icon('hang') + (ready ? 'Hang up' : 'Cancel') + '</button></div>';
    const on = (id, fn) => { const b = $('#' + id); if (b) b.onclick = fn; };
    on('hang', () => f.hangup());
    on('mute', () => f.mute(!f.muted));
    on('kp', () => { S.padOpen = !S.padOpen; drawCallZone(); });
    on('hold', () => run(() => f.hold(true), 'Could not put the call on hold.'));
    on('resume', () => run(async () => { if (other && other.state === 'active' && !parked(other)) await park(other); await unpark(f); }, 'Could not resume the call.'));
    on('add', () => { S.mode = 'add'; S.number = ''; drawCallZone(); const n = $('#num'); if (n) n.focus(); });
    on('xfer', () => { S.mode = 'transfer'; S.xfer = ''; drawCallZone(); });
    on('swap', swap);
    on('olswap', () => (parked(f) ? run(async () => { await unpark(other); }, 'Could not switch calls.') : swap()));
    on('connect', () => connect(other, f));
    on('merge', merge);
    const sel = $('#outsel');
    if (sel) sel.onchange = () => { S.sink = sel.value === 'default' ? '' : sel.value; store.set(OUT, S.sink); applySink(); say('Playing the call on ' + sel.options[sel.selectedIndex].text + '.'); };
    $$('#dtmf button').forEach(b => b.onclick = () => f.dtmf(b.dataset.k));
    tick();
  }
  // every redraw of the call screen also refreshes the bar and the menu label
  const drawCallZoneInner = drawCallZone;
  drawCallZone = function () { drawCallZoneInner(); drawCallBar(); };
  async function run(fn, failText) {
    S.busy = true; drawCallZone();
    try { await fn(); } catch (e) { toast(failText, 'bad'); }
    finally { S.busy = false; drawCallZone(); }
  }
  function tick() {
    clearInterval(S.timer);
    const draw = () => { const el = $('#clock'), c = S.focus; if (el && c && c.startedAt && c.state === 'active') el.textContent = dur(Math.round((Date.now() - c.startedAt) / 1000)); };
    draw(); S.timer = setInterval(draw, 1000);
  }

  // ------------------------------------------------------------------ the functions
  async function dial(number) {
    number = clean(number);
    if (!number) { toast('Type a number first.', 'warn'); return; }
    if (!S.ua || S.ua.state !== 'registered') { toast('Your phone is not connected yet. Wait for "Ready" at the top.', 'warn'); return; }
    if (talking().length) return addCall(number);
    S.number = number;
    try { await S.ua.call(number); } catch (e) { toast(e.message, 'bad'); }
  }
  async function addCall(number) {
    number = clean(number);
    if (!number) { toast('Type a number first.', 'warn'); return; }
    const calls = talking();
    if (calls.length >= 2) { toast('You already have two calls. End one first.', 'warn'); return; }
    const cur = calls[0];
    if (cur && cur.state !== 'active') { toast('Wait until this call is answered.', 'warn'); return; }
    S.mode = null; S.number = '';
    if (cur && !parked(cur)) {
      S.busy = true; drawCallZone();
      try { await park(cur); } catch (e) { /* checked below */ }
      S.busy = false;
      if (!parked(cur)) { toast('Could not put ' + label(cur) + ' on hold, so no second call was made.', 'bad'); drawCallZone(); return; }
    }
    try { await S.ua.call(number); } catch (e) { toast(e.message, 'bad'); }
    drawCallZone();
  }
  async function swap() {
    const f = S.focus, o = talking().find(c => c !== f);
    if (!f || !o) return;
    await run(async () => { await park(f); if (parked(f)) await unpark(o); }, 'Could not swap the calls.');
  }
  // attended transfer: the person on hold is connected to the person you are talking to, and you drop off
  async function connect(heldCall, current) {
    if (!heldCall || !current) return;
    const a = label(heldCall), b = label(current);
    S.busy = true; drawCallZone();
    const r = await heldCall.transfer(null, current);
    S.busy = false;
    if (r.ok) {
      toast('Connected ' + a + ' and ' + b + '.', 'ok');
      // the engine normally ends this leg too; if not, this phone does (RFC 5589: the transferor leaves both dialogs)
      setTimeout(() => { if (current.state === 'active') current.hangup(); }, 3000);
    } else toast('Could not transfer: ' + r.why + '. Both calls are still yours.', 'bad');
    drawCallZone();
  }
  // three-way call: both calls go into this phone's conference room, then this phone joins it
  async function merge() {
    const calls = talking();
    if (calls.length !== 2 || calls.some(c => c.state !== 'active')) return;
    S.busy = true; drawCallZone();
    try {
      const conf = calls.find(isConf);
      if (conf) {
        const other = calls.find(c => c !== conf);
        const r = await other.transfer(room());
        if (!r.ok) throw new Error(r.why);
        conf.aside(false);
        say(label(other) + ' joined the conference.');
        return;
      }
      // the call you are on first, then the one on hold (a transfer takes it off hold), then this phone
      const act = calls.find(c => !parked(c)) || calls[1], held = calls.find(c => c !== act);
      const r1 = await act.transfer(room());
      if (!r1.ok) throw new Error(r1.why);
      const r2 = await held.transfer(room());
      await S.ua.call(room()); // join even if the second move failed: the first person is waiting in the room
      if (!r2.ok) throw new Error(r2.why + '. ' + label(held) + ' is still on hold here');
      say('Conference call: you, ' + label(act) + ' and ' + label(held) + '.');
    } catch (e) {
      toast('Could not merge the calls: ' + e.message + '.', 'bad');
    } finally { S.busy = false; drawCallZone(); }
  }
  function press(k) {
    const f = S.focus;
    if (f && f.state === 'active' && !parked(f) && !S.mode) { f.dtmf(k); return; }
    if (S.mode === 'transfer') { setXfer((S.xfer + k).slice(0, 24)); return; }
    S.number = (S.number + k).slice(0, 24);
    const num = $('#num'); if (num) num.value = S.number;
    const nn = $('#numname'); if (nn) nn.textContent = nameFor(S.number);
  }
  // a name in the phone book or recent calls: call it; on a call, set it up as the second call; when transferring, the target
  function pick(n) {
    if (S.mode === 'transfer') { setTab('keypad'); return setXfer(n); }
    if (talking().length) {
      if (talking().length >= 2) return toast('You already have two calls. End one first.', 'warn');
      S.mode = 'add'; S.number = clean(n); setTab('keypad'); drawCallZone();
      const b = $('#call'); if (b) b.focus();
      return undefined;
    }
    setTab('keypad');
    return dial(n);
  }
  function drawQuick() {
    const el = $('#quick');
    if (!el) return;
    const q = quick().map(x => S.book.find(e => e.ext === x) || { ext: x, name: nameFor(x) || x, dept: '' });
    el.innerHTML = q.length ? q.map(e => '<div class="qd"><button type="button" class="qd-call" data-ext="' + esc(e.ext) + '" aria-label="Call ' + esc(e.name) + ', ' + esc(e.ext) + '">' +
      '<span class="qd-name">' + esc(e.name) + '</span><span class="qd-ext"><span class="mono">' + esc(e.ext) + '</span>' + (e.dept ? ' &middot; ' + esc(e.dept) : '') + '</span></button>' +
      '<button type="button" class="iconbtn qd-x" data-ext="' + esc(e.ext) + '" aria-label="Remove ' + esc(e.name) + ' from quick dial">' + icon('x') + '</button></div>').join('')
      : '<p class="empty">No quick dials yet. Open the phone book and tap the star beside a name to put them here.</p>';
    $$('#quick .qd-call').forEach(b => b.onclick = () => pick(b.dataset.ext));
    $$('#quick .qd-x').forEach(b => b.onclick = () => toggleQuick(b.dataset.ext));
  }
  function drawBook() {
    const q = S.query.trim().toLowerCase();
    const hits = S.book.filter(e => e.ext !== S.creds.ext && (!q || (e.ext + ' ' + e.name + ' ' + e.dept).toLowerCase().includes(q))).slice(0, 200);
    const qd = quick();
    $('#book').innerHTML = hits.length ? hits.map(e => '<li><button type="button" class="person" data-ext="' + esc(e.ext) + '" aria-label="' + esc(e.name) + ', ' + esc(e.ext) + '">' +
      '<span class="p-name">' + esc(e.name) + '</span><span class="p-dept muted">' + esc(e.dept) + '</span><span class="p-ext mono">' + esc(e.ext) + '</span>' + icon('phone') + '</button>' +
      '<button type="button" class="iconbtn star" data-ext="' + esc(e.ext) + '" aria-pressed="' + qd.includes(e.ext) + '" aria-label="Quick dial ' + esc(e.name) + '">' + icon('star') + '</button></li>').join('')
      : '<li class="empty">' + (q ? 'No one matches "' + esc(S.query) + '".' : 'The phone book is empty.') + '</li>';
    $$('#book .person').forEach(b => b.onclick = () => pick(b.dataset.ext));
    $$('#book .star').forEach(b => b.onclick = () => toggleQuick(b.dataset.ext));
  }
  function drawRecent() {
    const list = recent();
    $('#recent').innerHTML = list.length ? list.map(r => '<li><button type="button" class="person" data-ext="' + esc(r.number) + '" aria-label="' + esc(r.name || r.number) + ', ' + esc(r.result === 'answered' ? 'answered' : r.result) + '">' +
      icon(r.dir === 'in' ? 'in' : 'out') + '<span class="p-name">' + esc(r.name || r.number) + '</span><span class="p-dept muted">' + esc(r.result === 'answered' ? dur(r.secs) : r.result) + '</span><span class="p-ext mono">' + esc(hhmm(r.at)) + '</span></button></li>').join('')
      : '<li class="empty">No calls yet from this browser.</li>';
    $$('#recent .person').forEach(b => b.onclick = () => pick(b.dataset.ext));
  }

  // ------------------------------------------------------------------ the call lifecycle, from the SIP stack
  function onCallUpdate(c) {
    if (c.state === 'ended') {
      remember(c); drawRecent();
      const quiet = ['hung up', 'the other side hung up', 'cancelled', 'declined', 'answered elsewhere'].includes(c.reason);
      if (c.reason === 'missed' && c.dir === 'in') toast('Missed call from ' + label(c) + '.', 'warn');
      else if (c.reason === 'transferred') { /* the screen that started it says how it went */ }
      else if (!quiet) toast(explain(c), 'bad');
      const rest = talking();
      if (rest.length === 1 && rest[0].asideOn) rest[0].aside(false); // back to the conference
      else if (rest.length === 1 && rest[0].held && !S.busy) say(label(rest[0]) + ' is still on hold. Press Resume to talk.', true);
      if (!rest.length) { clearInterval(S.timer); S.padOpen = false; S.mode = null; say('Call ended.'); }
    }
    if (S.ringing && S.ringing.state !== 'ringing') S.ringing = null;
    if (ringingIn().length) showIncoming(); else hideIncoming();
    syncTones();
    const t = talking();
    d.title = ringingIn().length ? 'Incoming call - PMC Phone' : t.length ? 'On call - PMC Phone' : 'PMC Phone';
    drawCallZone();
  }
  function explain(c) {
    const who = label(c);
    switch (c.reason) {
      case 'busy': return who + ' is on another call. Try again shortly.';
      case 'not found': return 'No one has the number ' + c.number + '. Check it in the phone book.';
      case 'not answering': return who + ' did not answer, or their phone is not connected.';
      case 'not allowed': return isConf(c) ? 'The conference room would not let this phone in.' : 'The phone system did not allow that call.';
      case 'the microphone is blocked for this page': return 'Your microphone is blocked. Click the lock icon in the address bar, allow the microphone, then try again.';
      case 'could not agree on audio': return 'The call could not start: the phone system and this browser could not agree on audio. Tell PMO ICT.';
      default: return 'The call ended: ' + c.reason + '.';
    }
  }

  // ------------------------------------------------------------------ incoming, and call waiting
  function showIncoming() {
    const c = ringingIn()[0];
    if (!c) { hideIncoming(); return; }
    const waiting = talking().length > 0;
    const fresh = S.ringing !== c || $('#incoming').classList.contains('hidden');
    S.ringing = c;
    const who = c.name || nameFor(c.number) || 'Unknown caller';
    $('#in-title').textContent = waiting ? 'Call waiting' : 'Incoming call';
    $('#in-who').innerHTML = esc(who) + (c.number ? '<br><span class="mono">' + esc(c.number) + '</span>' : '');
    $('#in-answer').classList.toggle('hidden', waiting);
    $('#in-hold').classList.toggle('hidden', !waiting);
    $('#in-end').classList.toggle('hidden', !waiting);
    $('#incoming').classList.remove('hidden');
    syncTones();
    if (!fresh) return;
    say((waiting ? 'Call waiting from ' : 'Incoming call from ') + who + (c.number ? ', ' + c.number : '') + '.', true);
    (waiting ? $('#in-hold') : $('#in-answer')).focus();
    if (d.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification(waiting ? 'Call waiting' : 'Incoming call', { body: who + (c.number ? ' (' + c.number + ')' : ''), tag: 'pmc-call', requireInteraction: true }); n.onclick = () => { window.focus(); n.close(); }; } catch (e) { /* not allowed */ }
    }
  }
  function hideIncoming() { $('#incoming').classList.add('hidden'); }
  async function answerRinging(endOthers) {
    const c = S.ringing;
    if (!c || c.state !== 'ringing') return;
    stopTones(); hideIncoming(); S.ringing = null;
    setTab('keypad');
    for (const o of talking()) {
      if (endOthers) o.hangup();
      else if (o.state === 'active' && !parked(o)) { try { await park(o); } catch (e) { /* answer anyway */ } }
      else if (o.state !== 'active') o.hangup(); // a call still being dialled cannot be held
    }
    await c.answer();
  }
  $('#in-answer').onclick = () => answerRinging(false);
  $('#in-hold').onclick = () => answerRinging(false);
  $('#in-end').onclick = () => answerRinging(true);
  $('#in-decline').onclick = () => { const c = S.ringing; if (!c) return; stopTones(); hideIncoming(); S.ringing = null; c.decline(); };

  // ------------------------------------------------------------------ keyboard
  const inField = ev => { const t = ev.target; return t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); };
  d.addEventListener('keydown', ev => {
    if (!S.creds) return;
    if (!$('#incoming').classList.contains('hidden')) {
      if (ev.key === 'Escape') { ev.preventDefault(); $('#in-decline').click(); }
      else if (ev.key === 'Tab') { // keep focus inside the incoming box
        const b = $$('#incoming button').filter(x => !x.classList.contains('hidden'));
        const i = b.indexOf(d.activeElement);
        ev.preventDefault(); b[(i + (ev.shiftKey ? -1 : 1) + b.length) % b.length].focus();
      }
      return;
    }
    const f = S.focus;
    if (ev.key === 'Escape') {
      if (S.mode && talking().length) { ev.preventDefault(); S.mode = null; drawCallZone(); return; }
      if (f) { ev.preventDefault(); f.hangup(); return; }
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const target = ev.target;
    if (target && target.id === 'q') return;
    const tones = f && f.state === 'active' && !parked(f) && !S.mode;
    if (/^[0-9*#]$/.test(ev.key) && (!inField(ev) || (target && (target.id === 'num' || target.id === 'xnum')))) {
      if (target && (target.id === 'num' || target.id === 'xnum') && !tones) return; // the field types it itself
      ev.preventDefault(); press(ev.key); return;
    }
    if (inField(ev)) return;
    if (ev.key === 'Enter' && !talking().length) { ev.preventDefault(); dial(S.number); }
    else if (ev.key === '/') { ev.preventDefault(); setTab('book'); const q = $('#q'); if (q) q.focus(); }
    else if (ev.key === 't') toggleTheme();
  });

  // ------------------------------------------------------------------ start
  async function boot() {
    try { S.me = await api('GET', '/api/me'); } catch (e) { if (e.status === 401) return renderLogin(); return renderLogin('The phone system did not answer. Try again in a minute.'); }
    try { S.creds = await api('GET', '/api/softphone'); }
    catch (e) {
      showStatusPlain('No phone', 'bad');
      $('#who').innerHTML = '<span class="name">' + esc(S.me.display || S.me.name) + '</span><span class="sep">&middot;</span><a href="#" id="out">Sign out</a>';
      $('#out').onclick = signOut;
      $('#main').innerHTML = '<div class="login"><div class="card"><h2>No phone yet</h2><p class="sub">' + esc(e.message) + '</p>' +
        (S.me.role !== 'phone' ? '<p class="why"><a href="/">Open the phone directory instead</a></p>' : '') + '</div></div>';
      return;
    }
    try { S.book = (await api('GET', '/api/phonebook')).extensions || []; } catch (e) { S.book = []; }
    renderPhone();
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + S.creds.wsPath;
    S.ua = new PMCSip.UA({
      ext: S.creds.ext, password: S.creds.password, name: S.creds.name, domain: S.creds.domain, wsUrl,
      connect: (u, p) => new WebSocket(u, p), media: browserMedia($('#audios')),
      log: s => { if (window.PMC_DEBUG) console.log('[sip] ' + s); }
    });
    S.ua.dnd = S.dnd;
    S.ua.on('state', (s, why) => { showStatus(s, why || (s === 'registered' ? 'say' : '')); const b = $('#call'); if (b) b.disabled = s !== 'registered'; });
    S.ua.on('incoming', () => { showIncoming(); d.title = 'Incoming call - PMC Phone'; });
    S.ua.on('state', s => { if (s !== 'registered') { stopTones(); hideIncoming(); } });
    S.ua.on('call', () => { setTab('keypad'); drawCallZone(); });
    S.ua.on('update', onCallUpdate);
    S.ua.on('rejected', (c, why) => {
      keep({ dir: 'in', number: c.number, name: c.name || nameFor(c.number), at: Date.now(), secs: 0, result: why === 'do not disturb' ? 'do not disturb' : 'missed, you were busy' });
      drawRecent();
    });
    S.ua.start();
    window.addEventListener('beforeunload', () => { if (S.ua) S.ua.stop(); });
    if ('Notification' in window && Notification.permission === 'default') {
      d.addEventListener('click', () => { try { Notification.requestPermission(); } catch (e) { /* not offered */ } }, { once: true });
    }
  }
  // installed-app support: the worker caches nothing, it only shows a plain message when the server cannot be reached
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/phone' }).catch(() => {});
  boot();
})();
