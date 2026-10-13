'use strict';
/* PMC Phone - the browser phone screen. Plain JavaScript, no framework, the same shell, tokens and habits as the
   admin screen and the PSA desk. Signs in through /api/login, fetches only the signed-in person's own extension
   from /api/softphone, and talks SIP over /ws (sip.js). Media is a WebRTC RTCPeerConnection.

   Keyboard: digits, * and # dial (or send tones on a call); Enter calls; Escape hangs up or declines;
   / jumps to the phone book search; t switches light and dark. */
(function () {
  const d = document, root = d.documentElement;
  const $ = (s, c) => (c || d).querySelector(s);
  const $$ = (s, c) => Array.prototype.slice.call((c || d).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = n => '<svg class="ic" aria-hidden="true"><use href="#i-' + n + '"></use></svg>';

  // ------------------------------------------------------------------ preferences shared with the admin screen
  const THEME = 'pmc-phones-theme', RECENT = 'pmc-phone-recent';
  const store = { get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };
  const applyTheme = () => { root.dataset.theme = store.get(THEME) || 'dark'; };
  const toggleTheme = () => { store.set(THEME, root.dataset.theme === 'dark' ? 'light' : 'dark'); applyTheme(); };
  applyTheme();

  const S = { me: null, creds: null, book: [], ua: null, call: null, query: '', number: '', padOpen: false, timer: null, tones: null };

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
  function tones(kind) {
    stopTones();
    try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    if (ac.state === 'suspended') ac.resume();
    // ring: two short warbles every 3 s. ringback: 440+480 Hz, 2 s on, 4 s off (what a caller hears)
    const plan = kind === 'ring' ? { freqs: [660, 880], on: 0.4, gap: 0.2, bursts: 2, every: 3 } : { freqs: [440, 480], on: 2, gap: 0, bursts: 1, every: 6 };
    const gain = ac.createGain(); gain.gain.value = 0; gain.connect(ac.destination);
    const oscs = plan.freqs.map(f => { const o = ac.createOscillator(); o.frequency.value = f; o.connect(gain); o.start(); return o; });
    const level = kind === 'ring' ? 0.12 : 0.06;
    const schedule = () => {
      const t0 = ac.currentTime + 0.05;
      for (let b = 0; b < plan.bursts; b++) {
        const s = t0 + b * (plan.on + plan.gap);
        gain.gain.setValueAtTime(level, s); gain.gain.setValueAtTime(0, s + plan.on);
      }
    };
    schedule();
    const iv = setInterval(schedule, plan.every * 1000);
    S.tones = () => { clearInterval(iv); try { gain.gain.cancelScheduledValues(0); gain.gain.value = 0; oscs.forEach(o => o.stop()); gain.disconnect(); } catch (e) { /* closed */ } };
  }
  function stopTones() { if (S.tones) { S.tones(); S.tones = null; } }

  // ------------------------------------------------------------------ media: the browser's RTCPeerConnection
  function browserMedia(remoteEl) {
    return {
      async create() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('this browser cannot use a microphone on this page');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
        stream.getTracks().forEach(t => pc.addTrack(t, stream));
        pc.ontrack = ev => { remoteEl.srcObject = ev.streams[0] || new MediaStream([ev.track]); const p = remoteEl.play(); if (p && p.catch) p.catch(() => {}); };
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
          close() { stream.getTracks().forEach(t => t.stop()); try { pc.close(); } catch (e) { /* closed */ } remoteEl.srcObject = null; }
        };
      }
    };
  }

  // ------------------------------------------------------------------ the recent calls this browser keeps
  const recent = () => { try { return JSON.parse(store.get(RECENT) || '[]'); } catch (e) { return []; } };
  function remember(c) {
    const list = recent();
    list.unshift({ dir: c.dir, number: c.number, name: c.name || nameFor(c.number), at: c.startedAt || c.endedAt || Date.now(),
      secs: c.startedAt ? Math.round(((c.endedAt || Date.now()) - c.startedAt) / 1000) : 0, result: c.startedAt ? 'answered' : (c.reason || 'missed') });
    store.set(RECENT, JSON.stringify(list.slice(0, 25)));
  }
  const nameFor = n => { const e = S.book.find(x => x.ext === n); return e ? e.name : ''; };
  const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dur = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

  // ------------------------------------------------------------------ status
  const STATUS = {
    connecting: ['warn', 'Connecting'], registered: ['ok', 'Ready'], offline: ['bad', 'Offline, trying again'],
    denied: ['bad', 'Phone not accepted'], failed: ['bad', 'Phone not accepted']
  };
  function showStatus(state, why) {
    const [cls, text] = STATUS[state] || ['warn', state];
    const el = $('#status'); el.className = 'chip ' + cls;
    $('#status-text').textContent = text;
    el.title = why || '';
    if (state === 'registered') say('Your phone is ready. Calls to ' + S.creds.ext + ' ring here.');
    if (state === 'denied') { say('The phone system did not accept this phone. Ask ICT.', true); toast('The phone system did not accept this phone\'s password. Ask ICT to check extension ' + S.creds.ext + '.', 'bad'); }
  }

  // ------------------------------------------------------------------ sign in
  function renderLogin(message) {
    $('#who').innerHTML = '';
    showStatusPlain('Signed out', 'warn');
    $('#main').innerHTML = '<div class="login"><div class="card"><h2>Sign in to your phone</h2><p class="sub">Use the name and password ICT gave you. Calls to your extension will ring in this browser.</p>' +
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
  function renderPhone() {
    const c = S.creds;
    $('#who').innerHTML = '<span class="name">' + esc(c.name) + '</span><span class="sep">&middot;</span><span class="muted mono">' + esc(c.ext) + '</span>' +
      '<span class="sep">&middot;</span><button type="button" class="iconbtn" id="theme" aria-label="Switch light or dark" title="Light or dark (t)">' + icon('sun') + '</button>' +
      '<span class="sep">&middot;</span><a href="#" id="out">Sign out</a>';
    $('#theme').onclick = toggleTheme;
    $('#out').onclick = async ev => { ev.preventDefault(); if (S.ua) await S.ua.stop(); try { await api('POST', '/api/logout'); } catch (e) { /* already out */ } location.reload(); };
    $('#main').innerHTML =
      '<div class="phone-grid">' +
      '<section class="card dialer" aria-labelledby="dial-h"><h3 id="dial-h">' + icon('phone') + 'Your phone, ' + esc(c.ext) + '</h3>' +
      '<p class="sub">' + esc(c.name) + (c.dept ? ' &middot; ' + esc(c.dept) : '') + '</p>' +
      '<div id="callzone"></div></section>' +
      '<section class="card book" aria-labelledby="book-h"><h3 id="book-h">' + icon('users') + 'Phone book</h3>' +
      '<label class="sr-only" for="q">Search the phone book</label><div class="search">' + icon('search') + '<input id="q" type="search" placeholder="Name, department or number" autocomplete="off"></div>' +
      '<ul class="book-list" id="book" aria-label="People"></ul>' +
      '<h3 id="rec-h" class="rec-h">' + icon('clock') + 'Recent</h3><ul class="book-list recent" id="recent" aria-labelledby="rec-h"></ul></section>' +
      '</div>';
    $('#q').oninput = () => { S.query = $('#q').value; drawBook(); };
    drawBook(); drawRecent(); drawCallZone();
  }
  function drawCallZone() {
    const c = S.call;
    const z = $('#callzone');
    if (!c || c.state === 'ended') {
      z.innerHTML =
        '<div class="numbox"><label class="sr-only" for="num">Number to call</label><input id="num" class="num mono" inputmode="tel" autocomplete="off" placeholder="Number" value="' + esc(S.number) + '">' +
        '<button type="button" class="iconbtn" id="bk" aria-label="Delete last digit">' + icon('back') + '</button></div>' +
        '<div class="numname" id="numname" aria-live="polite">' + esc(nameFor(S.number)) + '</div>' +
        padHtml('pad') +
        '<div class="callrow"><button type="button" class="callbtn" id="call"' + (S.ua && S.ua.state === 'registered' ? '' : ' disabled') + '>' + icon('phone') + 'Call</button></div>' +
        '<p class="hint">Type or tap a number, or pick someone from the phone book. 9196 is an echo test: you hear yourself back.</p>';
      const num = $('#num');
      num.oninput = () => { S.number = num.value.replace(/[^0-9*#+]/g, ''); if (num.value !== S.number) num.value = S.number; $('#numname').textContent = nameFor(S.number); };
      num.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); dial(S.number); } };
      $('#bk').onclick = () => { S.number = S.number.slice(0, -1); num.value = S.number; $('#numname').textContent = nameFor(S.number); num.focus(); };
      $('#call').onclick = () => dial(S.number);
      $$('#pad button').forEach(b => b.onclick = () => { press(b.dataset.k); num.focus(); });
      return;
    }
    const who = c.name || nameFor(c.number) || '';
    const label = { calling: 'Calling', ringing: c.dir === 'out' ? 'Ringing' : 'Incoming', connecting: 'Connecting', active: c.held ? 'On hold' : 'On call' }[c.state] || c.state;
    z.innerHTML =
      '<div class="oncall" aria-live="polite"><div class="oc-who">' + esc(who || c.number) + '</div>' + (who ? '<div class="oc-num mono">' + esc(c.number) + '</div>' : '') +
      '<div class="oc-state"><span class="dot"></span><span>' + esc(label) + '</span> <span class="mono" id="clock"></span></div></div>' +
      (c.state === 'active' ? '<div class="controls">' +
        '<button type="button" class="ctl" id="mute" aria-pressed="' + c.muted + '">' + icon('mic-off') + (c.muted ? 'Unmute' : 'Mute') + '</button>' +
        '<button type="button" class="ctl" id="hold" aria-pressed="' + c.held + '">' + icon('pause') + (c.held ? 'Resume' : 'Hold') + '</button>' +
        '<button type="button" class="ctl" id="kp" aria-pressed="' + S.padOpen + '" aria-controls="dtmf">' + icon('grid') + 'Keypad</button></div>' +
        (S.padOpen ? padHtml('dtmf') : '') : '') +
      '<div class="callrow"><button type="button" class="hangbtn" id="hang">' + icon('hang') + (c.state === 'active' ? 'Hang up' : 'Cancel') + '</button></div>';
    $('#hang').onclick = () => c.hangup();
    if (c.state === 'active') {
      $('#mute').onclick = () => c.mute(!c.muted);
      $('#hold').onclick = async () => { $('#hold').disabled = true; try { await c.hold(!c.held); } catch (e) { toast('Could not ' + (c.held ? 'resume' : 'hold') + ' the call.', 'bad'); } };
      $('#kp').onclick = () => { S.padOpen = !S.padOpen; drawCallZone(); };
      $$('#dtmf button').forEach(b => b.onclick = () => c.dtmf(b.dataset.k));
    }
    tick();
  }
  const padHtml = id => '<div class="pad" id="' + id + '" role="group" aria-label="' + (id === 'dtmf' ? 'Keypad for menus' : 'Dial pad') + '">' +
    PAD.map(([k, s]) => '<button type="button" data-k="' + k + '" aria-label="' + (k === '*' ? 'star' : k === '#' ? 'hash' : k) + '"><b>' + k + '</b><small>' + (s || '&nbsp;') + '</small></button>').join('') + '</div>';
  function tick() {
    clearInterval(S.timer);
    const c = S.call;
    const draw = () => { const el = $('#clock'); if (el && c && c.startedAt && c.state === 'active') el.textContent = dur(Math.round((Date.now() - c.startedAt) / 1000)); };
    draw(); S.timer = setInterval(draw, 1000);
  }
  function press(k) {
    if (S.call && S.call.state === 'active') { S.call.dtmf(k); return; }
    S.number = (S.number + k).slice(0, 24);
    const num = $('#num'); if (num) num.value = S.number;
    const nn = $('#numname'); if (nn) nn.textContent = nameFor(S.number);
  }
  function drawBook() {
    const q = S.query.trim().toLowerCase();
    const hits = S.book.filter(e => e.ext !== S.creds.ext && (!q || (e.ext + ' ' + e.name + ' ' + e.dept).toLowerCase().includes(q))).slice(0, 200);
    $('#book').innerHTML = hits.length ? hits.map(e => '<li><button type="button" class="person" data-ext="' + esc(e.ext) + '" aria-label="Call ' + esc(e.name) + ', ' + esc(e.ext) + '">' +
      '<span class="p-name">' + esc(e.name) + '</span><span class="p-dept muted">' + esc(e.dept) + '</span><span class="p-ext mono">' + esc(e.ext) + '</span>' + icon('phone') + '</button></li>').join('')
      : '<li class="empty">' + (q ? 'No one matches "' + esc(S.query) + '".' : 'The phone book is empty.') + '</li>';
    $$('#book .person').forEach(b => b.onclick = () => dial(b.dataset.ext));
  }
  function drawRecent() {
    const list = recent();
    $('#recent').innerHTML = list.length ? list.map(r => '<li><button type="button" class="person" data-ext="' + esc(r.number) + '" aria-label="Call back ' + esc(r.name || r.number) + '">' +
      icon(r.dir === 'in' ? 'in' : 'out') + '<span class="p-name">' + esc(r.name || r.number) + '</span><span class="p-dept muted">' + esc(r.result === 'answered' ? dur(r.secs) : r.result) + '</span><span class="p-ext mono">' + esc(hhmm(r.at)) + '</span></button></li>').join('')
      : '<li class="empty">No calls yet from this browser.</li>';
    $$('#recent .person').forEach(b => b.onclick = () => dial(b.dataset.ext));
  }

  async function dial(number) {
    number = String(number || '').replace(/[^0-9*#+]/g, '');
    if (!number) { toast('Type a number first.', 'warn'); return; }
    if (S.call && S.call.state !== 'ended') { toast('Finish this call first.', 'warn'); return; }
    if (!S.ua || S.ua.state !== 'registered') { toast('Your phone is not connected yet. Wait for "Ready" at the top.', 'warn'); return; }
    S.number = number;
    try { await S.ua.call(number); } catch (e) { toast(e.message, 'bad'); }
  }

  // ------------------------------------------------------------------ the call lifecycle, from the SIP stack
  function onCallUpdate(c) {
    if (c.state === 'ended') {
      stopTones(); clearInterval(S.timer); hideIncoming();
      d.title = 'PMC Phone';
      if (S.call === c) S.call = null;
      S.padOpen = false;
      remember(c); drawRecent();
      const normal = ['hung up', 'the other side hung up', 'cancelled', 'declined'].includes(c.reason) || (c.reason === 'missed' && c.dir === 'in');
      if (c.reason === 'missed') toast('Missed call from ' + (c.name || nameFor(c.number) || c.number) + '.', 'warn');
      else if (!normal) toast(explain(c), 'bad');
      say('Call ended.');
      drawCallZone();
      return;
    }
    S.call = c;
    if (c.dir === 'out' && c.state === 'ringing') { if (!S.tones) tones('ringback'); }
    if (c.state === 'active') { stopTones(); hideIncoming(); d.title = 'On call - PMC Phone'; }
    if (c.dir === 'in' && c.state === 'ringing') return; // the incoming box handles it
    drawCallZone();
  }
  function explain(c) {
    const who = c.name || nameFor(c.number) || c.number;
    switch (c.reason) {
      case 'busy': return who + ' is on another call. Try again shortly.';
      case 'not found': return 'No one has the number ' + c.number + '. Check it in the phone book.';
      case 'not answering': return who + ' did not answer, or their phone is not connected.';
      case 'the microphone is blocked for this page': return 'Your microphone is blocked. Click the lock icon in the address bar, allow the microphone, then try again.';
      case 'could not agree on audio': return 'The call could not start: the phone system and this browser could not agree on audio. Tell ICT.';
      default: return 'The call ended: ' + c.reason + '.';
    }
  }
  function onIncoming(c) {
    S.call = c;
    const who = c.name || nameFor(c.number) || 'Unknown caller';
    $('#in-who').innerHTML = esc(who) + (c.number ? '<br><span class="mono">' + esc(c.number) + '</span>' : '');
    $('#incoming').classList.remove('hidden');
    tones('ring');
    d.title = 'Incoming call - PMC Phone';
    say('Incoming call from ' + who + (c.number ? ', ' + c.number : '') + '. Press Enter to answer, Escape to decline.', true);
    $('#in-answer').focus();
    if (d.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification('Incoming call', { body: who + (c.number ? ' (' + c.number + ')' : ''), tag: 'pmc-call', requireInteraction: true }); n.onclick = () => { window.focus(); n.close(); }; } catch (e) { /* not allowed */ }
    }
  }
  function hideIncoming() { $('#incoming').classList.add('hidden'); }
  $('#in-answer').onclick = async () => { const c = S.call; if (!c) return; stopTones(); hideIncoming(); await c.answer(); };
  $('#in-decline').onclick = () => { const c = S.call; if (!c) return; stopTones(); hideIncoming(); c.decline(); };

  // ------------------------------------------------------------------ keyboard
  const inField = ev => { const t = ev.target; return t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); };
  d.addEventListener('keydown', ev => {
    if (!S.creds) return;
    const inc = !$('#incoming').classList.contains('hidden');
    if (inc) {
      if (ev.key === 'Escape') { ev.preventDefault(); $('#in-decline').click(); }
      else if (ev.key === 'Tab') { // keep focus inside the incoming box
        const b = [$('#in-decline'), $('#in-answer')]; const i = b.indexOf(d.activeElement);
        ev.preventDefault(); b[(i + (ev.shiftKey ? -1 : 1) + 2) % 2].focus();
      }
      return;
    }
    if (ev.key === 'Escape' && S.call && S.call.state !== 'ended') { ev.preventDefault(); S.call.hangup(); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const target = ev.target;
    if (target && target.id === 'q') return;
    if (/^[0-9*#]$/.test(ev.key) && (!inField(ev) || (target && target.id === 'num'))) {
      if (target && target.id === 'num' && !(S.call && S.call.state === 'active')) return; // the field types it itself
      ev.preventDefault(); press(ev.key); return;
    }
    if (inField(ev)) return;
    if (ev.key === 'Enter' && !(S.call && S.call.state !== 'ended')) { ev.preventDefault(); dial(S.number); }
    else if (ev.key === '/') { ev.preventDefault(); const q = $('#q'); if (q) q.focus(); }
    else if (ev.key === 't') toggleTheme();
  });

  // ------------------------------------------------------------------ start
  async function boot() {
    try { S.me = await api('GET', '/api/me'); } catch (e) { if (e.status === 401) return renderLogin(); return renderLogin('The phone system did not answer. Try again in a minute.'); }
    try { S.creds = await api('GET', '/api/softphone'); }
    catch (e) {
      showStatusPlain('No phone', 'bad');
      $('#who').innerHTML = '<span class="name">' + esc(S.me.name) + '</span><span class="sep">&middot;</span><a href="#" id="out">Sign out</a>';
      $('#out').onclick = async ev => { ev.preventDefault(); try { await api('POST', '/api/logout'); } catch (x) { /* out */ } location.reload(); };
      $('#main').innerHTML = '<div class="login"><div class="card"><h2>No phone yet</h2><p class="sub">' + esc(e.message) + '</p>' +
        (S.me.role !== 'phone' ? '<p class="why"><a href="/">Open the phone directory instead</a></p>' : '') + '</div></div>';
      return;
    }
    try { S.book = (await api('GET', '/api/phonebook')).extensions || []; } catch (e) { S.book = []; }
    renderPhone();
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + S.creds.wsPath;
    S.ua = new PMCSip.UA({
      ext: S.creds.ext, password: S.creds.password, name: S.creds.name, domain: S.creds.domain, wsUrl,
      connect: (u, p) => new WebSocket(u, p), media: browserMedia($('#remote')),
      log: s => { if (window.PMC_DEBUG) console.log('[sip] ' + s); }
    });
    S.ua.on('state', (s, why) => { showStatus(s, why); const b = $('#call'); if (b) b.disabled = s !== 'registered'; });
    S.ua.on('incoming', onIncoming);
    S.ua.on('call', c => { if (c.dir === 'out') { S.call = c; drawCallZone(); } });
    S.ua.on('update', onCallUpdate);
    S.ua.start();
    window.addEventListener('beforeunload', () => { if (S.ua) S.ua.stop(); });
    if ('Notification' in window && Notification.permission === 'default') {
      d.addEventListener('click', () => { try { Notification.requestPermission(); } catch (e) { /* not offered */ } }, { once: true });
    }
  }
  boot();
})();
