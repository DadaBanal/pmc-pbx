'use strict';
/* PMC Phones - the screen. Plain browser JavaScript, no framework, the PSA's shell and habits:
   a floating bar with the pages, Ctrl+K to jump anywhere, n for a new phone, t for light or dark,
   a save bar that rises the moment a form changes, toasts that say what happened. Talks to /api/. */
(function () {
  const d = document, root = d.documentElement;
  const $ = (s, c) => (c || d).querySelector(s);
  const $$ = (s, c) => Array.prototype.slice.call((c || d).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n, cls) => '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + n + '"></use></svg>';
  // The model catalogue comes from the server, so a new vendor driver appears here with no change to this file.
  let MODELSPEC = {};
  const MODELS = new Proxy({}, { get: (_t, k) => (MODELSPEC[k] ? MODELSPEC[k].label : k) });
  const modelIds = () => Object.keys(MODELSPEC);
  const modelHasKeys = m => !!(MODELSPEC[m] && MODELSPEC[m].blf && MODELSPEC[m].lineKeys > 0);
  const modelKeyCount = m => (MODELSPEC[m] ? MODELSPEC[m].lineKeys : 0);
  // phone: staff on the browser phone only (phone.html); they never see this screen
  const ROLES = { phone: 1, viewer: 2, editor: 3, admin: 4 };
  // Engine states: "Not in use", "In use", "Busy", "Ringing", "On hold", "Unavailable". Only the first word decides.
  const onCall = state => /^(in use|busy|ringing|on hold)/i.test(String(state || '').trim());
  const PAGES = [
    { key: 'overview', label: 'Overview', icon: 'board', keyb: 'o' },
    { key: 'phones', label: 'Phones', icon: 'phone', keyb: 'p' },
    { key: 'departments', label: 'Departments', icon: 'building', keyb: 'd' },
    { key: 'live', label: 'Live status', icon: 'monitor', keyb: 'l' },
    { key: 'users', label: 'Users', icon: 'users', role: 'admin', keyb: 'u' },
    { key: 'history', label: 'History', icon: 'note', role: 'admin', keyb: 'h' }
  ];
  const S = { me: null, dir: null, status: null, liveTimer: null, page: '', sort: { key: 'ext', dir: 'asc' },
    filters: { dept: '', site: '', status: '', q: '' }, save: null, pendingG: false };

  // ---------------------------------------------------------------- preferences this browser keeps
  const PREF = { theme: 'pmc-phones-theme', text: 'pmc-phones-text', density: 'pmc-phones-density' };
  const pref = k => { try { return localStorage.getItem(PREF[k]) || ''; } catch (e) { return ''; } };
  const setPref = (k, v) => { try { if (v) localStorage.setItem(PREF[k], v); else localStorage.removeItem(PREF[k]); } catch (e) { /* private window */ } };
  function applyPrefs() {
    root.dataset.theme = pref('theme') || 'dark';
    if (pref('text')) root.dataset.text = pref('text'); else delete root.dataset.text;
    if (pref('density')) root.dataset.density = pref('density'); else delete root.dataset.density;
  }
  const toggleTheme = () => { setPref('theme', root.dataset.theme === 'dark' ? 'light' : 'dark'); applyPrefs(); };
  const cycleText = () => { const o = ['', 's', 'l']; setPref('text', o[(o.indexOf(pref('text')) + 1) % o.length]); applyPrefs(); };

  // ---------------------------------------------------------------- api, progress, toasts
  let inflight = 0;
  function progress(on) {
    const np = $('#nprog'); inflight += on ? 1 : -1;
    if (inflight > 0) np.className = 'go'; else { np.className = 'done'; setTimeout(() => { if (inflight === 0) np.className = ''; }, 350); }
  }
  async function api(method, path, body) {
    progress(true);
    try {
      const opt = { method, headers: { 'X-PMC-PBX': '1' }, credentials: 'same-origin' };
      if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
      const r = await fetch(path, opt);
      let data = null; try { data = await r.json(); } catch (e) { data = null; }
      if (r.status === 401 && path !== '/api/login') { S.me = null; renderLogin(); throw new Error('Please sign in'); }
      if (!r.ok) throw new Error((data && data.error) || ('request failed (' + r.status + ')'));
      return data;
    } finally { progress(false); }
  }
  function toast(msg, kind) {
    $$('.banner.toast').forEach(t => t.remove());
    const t = d.createElement('div'); t.className = 'banner toast ' + (kind === 'bad' ? 'err' : kind || '');
    t.innerHTML = esc(msg) + '<button class="iconbtn x" type="button" aria-label="Close">' + icon('x') + '</button>';
    d.body.appendChild(t); $('.x', t).onclick = () => t.remove();
    setTimeout(() => t.remove(), kind === 'bad' ? 9000 : 4000);
  }
  const can = role => !!S.me && (ROLES[S.me.role] || 0) >= ROLES[role];
  const busy = (btn, on) => { if (btn) { btn.setAttribute('aria-busy', on ? 'true' : 'false'); btn.disabled = !!on; } };

  // ---------------------------------------------------------------- save bar
  function showSave(n, handler) { S.save = handler; $('#savebar-text').textContent = n + (n === 1 ? ' change waiting' : ' changes waiting'); $('#savebar').classList.add('up'); }
  function hideSave() { S.save = null; $('#savebar').classList.remove('up'); }
  $('#savebar-btn').onclick = () => { if (S.save) S.save(); };

  // ---------------------------------------------------------------- shell
  function renderShell() {
    const nav = $('#nav');
    nav.innerHTML = PAGES.filter(p => !p.role || can(p.role)).map(p => '<a class="top" href="#/' + p.key + '" data-key="' + p.key + '" title="' + esc(p.label) + '">' + icon(p.icon) + '<span class="lbl">' + esc(p.label) + '</span></a>').join('') +
      (can('editor') ? '<a class="newbtn" href="#/phone/new" title="New phone (n)">' + icon('plus') + '<span class="lbl">New phone</span></a>' : '');
    $('#who').innerHTML = (S.me.ext ? '<a href="/phone" title="Open my browser phone, ' + esc(S.me.ext) + '">My phone</a><span class="sep">&middot;</span>' : '') + '<a href="#/password" class="name" title="Change my password">' + esc(S.me.name) + '</a><span class="sep">&middot;</span><span class="muted">' + esc(S.me.role) + '</span><span class="sep">&middot;</span><a href="#" id="out">sign out</a>' +
      '<button class="iconbtn" id="pal-open" type="button" title="Search and jump (Ctrl+K)" aria-label="Search and jump">' + icon('search') + '</button><span class="kbd">Ctrl K</span>' +
      '<button class="iconbtn" id="keys-open" type="button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">' + icon('keyboard') + '</button>' +
      '<button class="iconbtn" id="textsize" type="button" title="Text size" aria-label="Text size"><b style="font-size:13px;letter-spacing:-.5px">Aa</b></button>' +
      '<button class="iconbtn" id="theme" type="button" title="Light or dark (t)" aria-label="Light or dark">' + icon('sun') + '</button>';
    $('#out').onclick = async ev => { ev.preventDefault(); try { await api('POST', '/api/logout'); } catch (e) { /* already out */ } location.hash = ''; location.reload(); };
    $('#theme').onclick = toggleTheme; $('#textsize').onclick = cycleText;
    $('#pal-open').onclick = openPalette; $('#keys-open').onclick = () => $('#keys').classList.toggle('hidden');
  }
  function setActive(key) { $$('#nav a.top').forEach(a => a.classList.toggle('on', a.dataset.key === key)); }

  // ---------------------------------------------------------------- data
  async function loadAll() {
    MODELSPEC = await api('GET', '/api/models').catch(() => MODELSPEC);
    S.dir = await api('GET', '/api/directory');
    S.status = await api('GET', '/api/status').catch(() => null);
  }
  function phoneState(e) {
    const st = S.status; if (!st) return { cls: 'na', text: 'Unknown' };
    const p = st.endpoints.find(x => x.ext === e.ext);
    if (!p) return { cls: 'na', text: 'Not applied' };
    if (onCall(p.state)) return { cls: 'call', text: 'On a call' };
    return p.registered ? { cls: 'on', text: 'Online' } : { cls: 'off', text: 'Offline' };
  }
  const stateChip = e => { const s = phoneState(e); return '<span class="state ' + s.cls + '">' + s.text + '</span>'; };
  const stripChips = () => {
    const st = S.status; if (!st) return '<span class="chip bad"><i class="dot"></i>Status unavailable</span>';
    return '<div class="chips">' +
      (st.engine.state === 'ok' ? '<span class="chip ok"><i class="dot"></i>Engine running</span>' : '<span class="chip bad"><i class="dot"></i>Engine unreachable</span>') +
      (st.pending ? '<span class="chip warn"><i class="dot"></i>Changes not yet applied</span>' : '<span class="chip ok"><i class="dot"></i>All changes applied</span>') +
      '<span class="chip">' + st.registered + ' phone' + (st.registered === 1 ? '' : 's') + ' online</span>' +
      (st.certDaysLeft < 30 ? '<span class="chip warn">' + icon('shield') + 'Certificate: ' + st.certDaysLeft + ' days left</span>' : '') + '</div>';
  };

  // ---------------------------------------------------------------- router
  function route() {
    hideSave(); clearInterval(S.liveTimer); $('#keys').classList.add('hidden');
    if (!S.me) return renderLogin();
    const h = (location.hash || '#/overview').replace(/^#\/?/, '');
    const [page, arg] = h.split('/');
    S.page = page || 'overview';
    const views = { overview: renderOverview, phones: renderPhones, phone: () => renderEditor(arg === 'new' ? null : arg), departments: renderDepartments, live: renderLive, users: renderUsers, history: renderHistory, password: renderPassword };
    const pageDef = PAGES.find(p => p.key === S.page);
    if (pageDef && pageDef.role && !can(pageDef.role)) { location.hash = '#/overview'; return; }
    setActive(S.page === 'phone' ? 'phones' : S.page);
    (views[S.page] || renderOverview)();
    window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', route);

  // ---------------------------------------------------------------- sign in
  function renderLogin() {
    $('#nav').innerHTML = ''; $('#who').innerHTML = '';
    $('#main').innerHTML = '<div class="login"><div class="card"><h2>Sign in</h2><p class="sub">PMC Phones, the hospital telephone directory and phone setup.</p>' +
      '<form id="login"><div><label>Name</label><input name="name" autocomplete="username" required autofocus></div>' +
      '<div><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>' +
      '<button class="primary" type="submit">Sign in</button></form></div>' +
      '<p class="why" style="text-align:center">Accounts are given by ICT. Viewers see, editors change phones, administrators run the system. Staff with a browser phone go straight to it.</p></div>';
    $('#login').onsubmit = async ev => {
      ev.preventDefault(); const f = ev.target; busy($('button', f), true);
      try { S.me = await api('POST', '/api/login', { name: f.name.value, password: f.password.value }); if (S.me.role === 'phone') { location.replace('/phone'); return; } await loadAll(); renderShell(); if (!location.hash) location.hash = '#/overview'; else route(); }
      catch (e) { toast(e.message, 'bad'); busy($('button', f), false); }
    };
  }

  // ---------------------------------------------------------------- overview
  function renderOverview() {
    const st = S.status, dir = S.dir;
    const phones = dir.extensions.filter(e => e.mac).length;
    const tile = (n, l, ic, cls, href) => '<a class="tile ' + (cls || '') + '" href="' + href + '">' + icon(ic) + '<div class="n">' + n + '</div><div class="l">' + esc(l) + '</div></a>';
    const tiles = tile(dir.extensions.length, 'Numbers in the directory', 'layers', '', '#/phones') +
      tile(phones, 'Desk phones', 'phone', '', '#/phones') +
      tile(st ? st.registered : '?', 'Online now', 'check', st && st.registered ? 'on' : '', '#/live') +
      tile(st ? (st.pending ? 'Waiting' : 'Applied') : '?', st && st.pending ? 'Changes not yet on the engine' : 'Engine matches the directory', st && st.pending ? 'alert' : 'check', st && st.pending ? 'warn' : '', '#/phones') +
      tile(st ? st.certDaysLeft : '?', 'Days left on the certificate', 'shield', st && st.certDaysLeft < 30 ? 'bad' : '', '#/live');
    const byDept = dir.departments.map(dp => {
      const used = dir.extensions.filter(e => e.dept === dp.name).length; const size = dp.to - dp.from + 1;
      return '<tr><td>' + esc(dp.name) + '</td><td class="num">' + dp.from + '&ndash;' + dp.to + '</td><td class="right">' + used + '</td><td class="right">' + (size - used) + '</td></tr>';
    }).join('');
    $('#main').innerHTML = '<h1>Overview</h1><p class="sub">The hospital\'s phones at a glance.</p>' + stripChips() + '<div style="height:12px"></div><div class="tiles">' + tiles + '</div>' +
      '<div class="grid2"><div class="card"><h3>' + icon('monitor') + 'Engine</h3><dl class="kv">' +
      '<dt>State</dt><dd>' + (st ? (st.engine.state === 'ok' ? '<span class="pill live">running</span>' : '<span class="pill bad">unreachable</span> <span class="why">' + esc(st.engine.error || '') + '</span>') : '?') + '</dd>' +
      '<dt>Version</dt><dd>' + esc(st && st.engine.version ? st.engine.version.replace(/ built by.*$/, '') : '') + '</dd>' +
      '<dt>Active calls</dt><dd>' + (st && st.engine.activeCalls != null ? st.engine.activeCalls : '') + '</dd>' +
      '<dt>Applied version</dt><dd>' + (st ? esc(st.appliedVersion == null ? 'never' : st.appliedVersion) + (st.pending ? ' <span class="pill warn">directory is at ' + st.directoryVersion + '</span>' : '') : '') + '</dd>' +
      '<dt>Applied at</dt><dd>' + esc(st && st.appliedAt ? st.appliedAt.replace('T', ' ').slice(0, 16) + ' UTC' : '') + '</dd>' +
      '<dt>Last change</dt><dd>' + esc(dir.updatedAt ? dir.updatedAt.replace('T', ' ').slice(0, 16) + ' UTC by ' + dir.updatedBy : 'none yet') + '</dd></dl>' +
      (can('editor') && st && st.pending ? '<div class="actions"><button class="primary" id="apply">' + icon('check') + 'Apply changes now</button></div>' : '') + '</div>' +
      '<div class="card"><h3>' + icon('building') + 'Numbers by department</h3>' + (byDept ? '<table class="grid"><thead><tr><th>Department</th><th>Block</th><th class="right">In use</th><th class="right">Free</th></tr></thead><tbody>' + byDept + '</tbody></table>' : '<div class="empty">No departments yet.</div>') + '</div></div>' +
      (can('admin') ? '<div class="card" id="recent"><h3>' + icon('note') + 'Latest changes</h3><div class="empty">Loading...</div></div>' : '');
    if ($('#apply')) $('#apply').onclick = () => applyChanges($('#apply'));
    if (can('admin')) api('GET', '/api/audit?limit=8').then(rows => {
      const box = $('#recent'); if (!box) return;
      box.innerHTML = '<h3>' + icon('note') + 'Latest changes</h3>' + (rows.length ? '<ul class="timeline">' + rows.map(r => '<li><span class="when">' + esc((r.at || '').replace('T', ' ').slice(0, 16)) + '</span> &middot; <b>' + esc(r.who) + '</b> ' + esc(r.action) + (r.detail ? ' <span class="muted">' + esc(r.detail) + '</span>' : '') + '</li>').join('') + '</ul><a href="#/history">All history &rarr;</a>' : '<div class="empty">Nothing yet.</div>');
    }).catch(() => {});
  }

  async function applyChanges(btn) {
    busy(btn, true);
    try {
      const r = await api('POST', '/api/apply');
      toast('Applied version ' + r.manifest.directoryVersion + ': ' + r.manifest.extensions + ' numbers, ' + r.manifest.phones + ' phones. Engine reloaded and checked.', 'ok');
    } catch (e) { toast('Not applied: ' + e.message, 'bad'); }
    await loadAll(); route();
  }

  // ---------------------------------------------------------------- phones
  function filteredPhones() {
    const f = S.filters, q = f.q.toLowerCase();
    let rows = S.dir.extensions.filter(e => (!f.dept || e.dept === f.dept) && (!f.site || e.site === f.site) &&
      (!f.status || phoneState(e).cls === f.status) && (!q || [e.ext, e.name, e.dept, e.mac, e.site, e.notes].join(' ').toLowerCase().includes(q)));
    const k = S.sort.key, dir = S.sort.dir === 'asc' ? 1 : -1;
    const val = e => k === 'status' ? phoneState(e).text : k === 'model' ? (MODELS[e.model] || e.model) : String(e[k] == null ? '' : e[k]);
    rows.sort((a, b) => val(a).localeCompare(val(b), undefined, { numeric: true }) * dir);
    return rows;
  }
  function renderPhones() {
    const dir = S.dir;
    const opts = (list, cur, all) => '<option value="">' + esc(all) + '</option>' + list.map(v => '<option' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
    const sites = Array.from(new Set(dir.extensions.map(e => e.site))).sort();
    $('#main').innerHTML = '<h1>Phones</h1><p class="sub">Every number, who has it, and whether the phone is online.</p>' + stripChips() + '<div style="height:12px"></div>' +
      '<div class="card"><form class="toolbar" id="filters"><div><label>Department</label><select name="dept">' + opts(dir.departments.map(x => x.name), S.filters.dept, 'All departments') + '</select></div>' +
      '<div><label>Site</label><select name="site">' + opts(sites, S.filters.site, 'All sites') + '</select></div>' +
      '<div><label>Status</label><select name="status"><option value="">Any</option>' + [['on', 'Online'], ['off', 'Offline'], ['call', 'On a call'], ['na', 'Not applied']].map(([v, l]) => '<option value="' + v + '"' + (S.filters.status === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>' +
      '<div class="wide"><label>Search</label><input name="q" value="' + esc(S.filters.q) + '" placeholder="number, name, department, MAC" autocomplete="off"></div>' +
      '<div style="min-width:0"><button type="submit" class="ghost">' + icon('filter') + 'Filter</button></div></form></div>' +
      '<div class="card"><div class="pager" style="padding:0 0 10px;justify-content:flex-start"><span class="densi"><button type="button" class="ghost small" data-density="" aria-pressed="' + (!pref('density')) + '">Comfortable</button><button type="button" class="ghost small" data-density="compact" aria-pressed="' + (pref('density') === 'compact') + '">Compact</button></span>' +
      '<span id="count"></span><span class="spacer" style="flex:1"></span>' +
      (can('editor') ? '<button type="button" class="ghost" id="apply"' + (S.status && !S.status.pending ? ' disabled' : '') + '>' + icon('check') + 'Apply changes</button><a class="btn primary" href="#/phone/new">' + icon('plus') + 'Add a phone</a>' : '') + '</div>' +
      '<div class="tablewrap" id="tbl"></div></div>';
    const f = $('#filters');
    f.onsubmit = ev => { ev.preventDefault(); readFilters(); drawTable(); };
    f.q.oninput = () => { readFilters(); drawTable(); };
    f.dept.onchange = f.site.onchange = f.status.onchange = () => { readFilters(); drawTable(); };
    $$('[data-density]').forEach(b => b.onclick = () => { setPref('density', b.dataset.density); applyPrefs(); $$('[data-density]').forEach(x => x.setAttribute('aria-pressed', x.dataset.density === b.dataset.density)); });
    if ($('#apply')) $('#apply').onclick = () => applyChanges($('#apply'));
    function readFilters() { S.filters = { dept: f.dept.value, site: f.site.value, status: f.status.value, q: f.q.value }; }
    function drawTable() {
      const rows = filteredPhones();
      $('#count').textContent = rows.length + ' of ' + dir.extensions.length + ' numbers';
      const th = (key, label, cls) => '<th class="sort' + (S.sort.key === key ? ' on' : '') + (cls ? ' ' + cls : '') + '" data-sort="' + key + '">' + esc(label) + (S.sort.key === key ? (S.sort.dir === 'asc' ? ' &#9650;' : ' &#9660;') : '') + '</th>';
      $('#tbl').innerHTML = rows.length ? '<table class="grid"><thead><tr>' + th('ext', 'Number') + th('name', 'Name on the phone') + th('dept', 'Department') + th('site', 'Site') + th('model', 'Phone') + '<th>MAC</th><th>Voicemail</th>' + th('status', 'Status') + '<th></th></tr></thead><tbody>' +
        rows.map(e => { const s = phoneState(e); return '<tr class="rowlink' + (s.cls === 'on' ? ' s-ok' : s.cls === 'na' ? ' s-warn' : '') + '" data-ext="' + esc(e.ext) + '"><td class="num"><a href="#/phone/' + esc(e.ext) + '">' + esc(e.ext) + '</a></td><td class="wrap">' + esc(e.name) + '</td><td>' + esc(e.dept) + '</td><td>' + esc(e.site) + '</td><td>' + esc(MODELS[e.model] || e.model) + '</td><td class="mono muted">' + esc(e.mac ? e.mac.replace(/(..)(?=.)/g, '$1:') : '') + '</td><td>' + (e.voicemail ? 'Yes' : 'No') + '</td><td><span class="state ' + s.cls + '">' + s.text + '</span></td>' +
          '<td class="right">' + (can('editor') ? '<a class="btn ghost small" href="#/phone/' + esc(e.ext) + '">' + icon('edit') + 'Edit</a>' : '') + '</td></tr>'; }).join('') + '</tbody></table>' :
        '<div class="empty">No numbers match. ' + (dir.extensions.length ? 'Clear the filters.' : 'Add the first phone.') + '</div>';
      $$('#tbl th.sort').forEach(h => h.onclick = () => { const k = h.dataset.sort; S.sort = { key: k, dir: S.sort.key === k && S.sort.dir === 'asc' ? 'desc' : 'asc' }; drawTable(); });
      $$('#tbl tr.rowlink').forEach(tr => tr.onclick = ev => { if (ev.target.closest('a')) return; location.hash = '#/phone/' + tr.dataset.ext; });
    }
    drawTable();
  }

  // ---------------------------------------------------------------- the phone editor
  function renderEditor(ext) {
    const dir = S.dir; const isNew = !ext;
    const cur = isNew ? null : dir.extensions.find(e => e.ext === ext);
    if (!isNew && !cur) { toast('No number ' + ext, 'bad'); location.hash = '#/phones'; return; }
    if (!can('editor')) { location.hash = '#/phones'; return; }
    const e = cur ? JSON.parse(JSON.stringify(cur)) : { ext: '', name: '', dept: (dir.departments[0] || {}).name || '', site: 'PMC', model: 'T31P', mac: '', voicemail: true, keys: [], notes: '' };
    const others = dir.extensions.filter(x => x.ext !== e.ext).sort((a, b) => a.ext.localeCompare(b.ext));
    const depts = dir.departments.map(x => '<option' + (x.name === e.dept ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('');
    const keyRow = k => '<div class="keyrow"><select data-k="type"><option value="blf"' + (k.type === 'blf' ? ' selected' : '') + '>Watch and dial</option><option value="speed"' + (k.type === 'speed' ? ' selected' : '') + '>Dial only</option></select>' +
      '<select data-k="ext">' + others.map(o => '<option value="' + esc(o.ext) + '"' + (o.ext === k.ext ? ' selected' : '') + '>' + esc(o.ext + '  ' + o.name) + '</option>').join('') + '</select>' +
      '<input data-k="label" placeholder="Label on the button (optional)" value="' + esc(k.label || '') + '" maxlength="20"><button class="ghost small" type="button" data-delkey>' + icon('x') + 'Remove</button></div>';
    const s = cur ? phoneState(cur) : null;
    $('#main').innerHTML = '<a class="btn ghost small" href="#/phones" style="margin-bottom:10px">' + icon('left') + 'All phones</a>' +
      '<h1>' + (isNew ? 'New phone' : 'Edit ' + esc(e.ext) + ' &middot; ' + esc(e.name)) + '</h1><p class="sub">' + (isNew ? 'The next free number in the department is filled in. Change it if the desk already has a number.' : 'Changes reach the phone at the next Apply.') + (s ? ' <span class="state ' + s.cls + '">' + s.text + '</span>' : '') + '</p>' +
      '<form id="pf"><div class="card"><h3>' + icon('phone') + 'The number</h3><div class="fields">' +
      '<div class="field"><label>Department</label><select name="dept">' + depts + '</select></div>' +
      '<div class="field"><label>Extension number</label><input name="ext" class="mono" value="' + esc(e.ext) + '" pattern="[1-9][0-9]{3}" maxlength="4" inputmode="numeric"' + (isNew ? '' : ' readonly title="A number cannot be renamed; remove it and add a new one"') + '></div>' +
      '<div class="field"><label>Name shown on the phone and in the directory</label><input name="name" value="' + esc(e.name) + '" maxlength="40" required placeholder="Nurse Station 2, Dr Santos, Pharmacy counter"></div>' +
      '<div class="field"><label>Site</label><select name="site"><option' + (e.site === 'PMC' ? ' selected' : '') + '>PMC</option><option' + (e.site === 'JRBY' ? ' selected' : '') + '>JRBY</option></select></div>' +
      '<div class="field"><label>Phone</label><select name="model">' + (function () {
        const byVendor = {};
        for (const mm of modelIds()) { const v = MODELSPEC[mm].vendor; (byVendor[v] = byVendor[v] || []).push(mm); }
        return Object.keys(byVendor).map(v => '<optgroup label="' + esc(v) + '">' + byVendor[v].map(mm =>
          '<option value="' + mm + '"' + (mm === e.model ? ' selected' : '') + '>' + esc(MODELSPEC[mm].label) + '</option>').join('') + '</optgroup>').join('');
      })() + '</select></div>' +
      '<div class="field"><label>Desk phone MAC (the sticker under the phone)</label><input name="mac" class="mono" value="' + esc(e.mac) + '" placeholder="00:15:65:xx:xx:xx" autocomplete="off"></div>' +
      '<div class="field check"><input type="checkbox" name="voicemail" id="vm"' + (e.voicemail ? ' checked' : '') + '><label for="vm">Voicemail on this number</label></div>' +
      '<div class="field"><label>Notes (for ICT)</label><input name="notes" value="' + esc(e.notes) + '" maxlength="200"></div></div></div>' +
      '<div class="card" id="keycard"><h3>' + icon('sparkle') + 'Buttons on the phone</h3><p class="why" id="keywhy" style="margin:0 0 10px">Watch a colleague\'s light and dial them with one press, or dial only.</p><div class="keys" id="keys-list">' + e.keys.map(keyRow).join('') + '</div><div class="actions" style="justify-content:flex-start"><button class="ghost small" type="button" id="addkey">' + icon('plus') + 'Add a button</button></div></div>' +
      '<div class="actions"><span class="spacer"></span>' + (!isNew ? '<button class="danger" type="button" id="remove">' + icon('trash') + 'Remove this number</button>' : '') + (!isNew && can('admin') ? '<button class="ghost" type="button" id="secrets">' + icon('lock') + 'First-time setup details</button>' : '') + '<a class="btn ghost" href="#/phones">Cancel</a><button class="primary" type="submit" id="save">' + icon('check') + (isNew ? 'Add the phone' : 'Save') + '</button></div>' +
      '<div id="secretbox"></div></form>';
    const f = $('#pf');
    const keys = () => $$('#keys-list .keyrow').map(r => ({ type: $('[data-k=type]', r).value, ext: $('[data-k=ext]', r).value, label: $('[data-k=label]', r).value }));
    const snapshot = () => JSON.stringify({ ext: f.ext.value.trim(), name: f.name.value, dept: f.dept.value, site: f.site.value, model: f.model.value, mac: f.mac.value, voicemail: f.voicemail.checked, keys: keys(), notes: f.notes.value });
    let base = snapshot();
    const dirty = () => { const now = JSON.parse(snapshot()), was = JSON.parse(base); let n = 0; for (const k in now) if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) n++; if (n || isNew) showSave(n || 1, () => f.requestSubmit()); else hideSave(); };
    const wireKeys = () => $$('[data-delkey]').forEach(b => b.onclick = () => { b.closest('.keyrow').remove(); keysForModel(); dirty(); });
    function keysForModel() {
      const mm = f.model.value, n = modelKeyCount(mm), has = modelHasKeys(mm);
      const rows = $$('#keys-list .keyrow').length;
      $('#keycard').classList.toggle('hidden', !has);
      $('#addkey').disabled = !has || rows >= n;
      $('#keywhy').textContent = has
        ? 'Watch a colleague and dial with one press, or dial only. This phone has ' + n + ' key' + (n === 1 ? '' : 's') + ', ' + rows + ' in use.'
        : '';
    }
    wireKeys();
    f.model.addEventListener('change', keysForModel);
    keysForModel();
    f.addEventListener('input', dirty); f.addEventListener('change', dirty);
    $('#addkey').onclick = () => { if (!others.length) return toast('Add other numbers first', 'bad'); $('#keys-list').insertAdjacentHTML('beforeend', keyRow({ type: 'blf', ext: others[0].ext, label: '' })); wireKeys(); keysForModel(); dirty(); };
    if (isNew) {
      const next = async () => { try { const r = await api('GET', '/api/extensions/next?dept=' + encodeURIComponent(f.dept.value)); f.ext.value = r.ext || ''; base = snapshot(); } catch (err) { /* keep */ } };
      f.dept.addEventListener('change', next); next();
    }
    if ($('#remove')) $('#remove').onclick = async () => {
      if (!confirm('Remove ' + e.ext + ' ' + e.name + '? The phone stops working at the next Apply.')) return;
      try { await api('DELETE', '/api/extensions/' + e.ext); toast('Removed ' + e.ext + '. Apply changes when ready.'); await loadAll(); hideSave(); location.hash = '#/phones'; } catch (err) { toast(err.message, 'bad'); }
    };
    if ($('#secrets')) $('#secrets').onclick = async () => {
      try {
        const r = await api('GET', '/api/extensions/' + e.ext + '/provisioning');
        $('#secretbox').innerHTML = '<div class="note warn" style="margin-top:14px"><b>First-time setup for this phone</b> ' +
          '<span class="why">' + esc((r.vendor || '') + (r.model ? ' ' + r.model : '')) + ' &middot; shown to administrators only; this view is recorded in History</span>' +
          '<ol style="margin:10px 0 0 18px;padding:0;line-height:1.7">' + (r.notes || []).map(n => '<li class="mono" style="font-size:12.5px">' + esc(n) + '</li>').join('') + '</ol>' +
          (r.files && r.files.length
            ? '<p class="why" style="margin:10px 0 0">Files this phone fetches: ' + r.files.map(n => '<span class="mono">' + esc(n) + '</span>').join(', ') + '</p>'
            : '<p class="why" style="margin:10px 0 0">Nothing generated for it yet; press Apply changes.</p>') + '</div>';
      } catch (err) { toast(err.message, 'bad'); }
    };
    f.onsubmit = async ev => {
      ev.preventDefault(); busy($('#save'), true);
      const body = JSON.parse(snapshot());
      try {
        if (isNew) { const r = await api('POST', '/api/extensions', body); toast('Added ' + r.ext + ' ' + body.name + '. Apply changes when ready.'); }
        else { await api('PUT', '/api/extensions/' + e.ext, body); toast('Saved ' + e.ext + '. Apply changes when ready.'); }
        await loadAll(); hideSave(); location.hash = '#/phones';
      } catch (err) { toast(err.message, 'bad'); busy($('#save'), false); }
    };
  }

  // ---------------------------------------------------------------- departments
  function renderDepartments() {
    const dir = S.dir; const ro = !can('admin');
    const used = name => dir.extensions.filter(e => e.dept === name).length;
    const row = (dp, n) => '<tr><td>' + (ro ? esc(dp.name) : '<input data-d="name" value="' + esc(dp.name) + '" placeholder="Department">') + '</td><td class="num">' + (ro ? dp.from : '<input data-d="from" class="mono" value="' + esc(dp.from) + '" inputmode="numeric" style="width:90px">') + '</td><td class="num">' + (ro ? dp.to : '<input data-d="to" class="mono" value="' + esc(dp.to) + '" inputmode="numeric" style="width:90px">') + '</td><td class="right">' + n + '</td><td class="right">' + (ro ? '' : '<button class="ghost small" type="button" data-deldept' + (n ? ' disabled title="Numbers still use it"' : '') + '>' + icon('x') + 'Remove</button>') + '</td></tr>';
    $('#main').innerHTML = '<h1>Departments</h1><p class="sub">Each department owns a block of four-digit numbers. A new phone takes the next free number in its department.</p>' +
      '<div class="card"><table class="grid"><thead><tr><th>Department</th><th>From</th><th>To</th><th class="right">Numbers in use</th><th></th></tr></thead><tbody id="drows">' + dir.departments.map(dp => row(dp, used(dp.name))).join('') + '</tbody></table>' +
      (ro ? '' : '<div class="actions" style="justify-content:flex-start"><button class="ghost small" type="button" id="adddept">' + icon('plus') + 'Add a department</button></div>') + '</div>';
    if (ro) return;
    const wire = () => $$('[data-deldept]').forEach(b => b.onclick = () => { b.closest('tr').remove(); dirty(); });
    const read = () => $$('#drows tr').map(r => ({ name: $('[data-d=name]', r).value, from: Number($('[data-d=from]', r).value), to: Number($('[data-d=to]', r).value) }));
    const base = JSON.stringify(dir.departments);
    const dirty = () => { const n = read(); const changed = JSON.stringify(n) !== base; if (changed) showSave(Math.max(1, Math.abs(n.length - dir.departments.length) || 1), save); else hideSave(); };
    const save = async () => { try { await api('PUT', '/api/departments', { departments: read() }); toast('Departments saved', 'ok'); await loadAll(); hideSave(); renderDepartments(); } catch (e) { toast(e.message, 'bad'); } };
    wire(); $('#drows').addEventListener('input', dirty);
    $('#adddept').onclick = () => { $('#drows').insertAdjacentHTML('beforeend', row({ name: '', from: '', to: '' }, 0)); wire(); dirty(); };
  }

  // ---------------------------------------------------------------- live status
  function renderLive() {
    const draw = () => {
      const st = S.status;
      if (!st) { $('#main').innerHTML = '<h1>Live status</h1><div class="card"><div class="empty">Status unavailable.</div></div>'; return; }
      const rows = st.endpoints.slice().sort((a, b) => a.ext.localeCompare(b.ext));
      const online = rows.filter(p => p.registered && !onCall(p.state)).length, calling = rows.filter(p => onCall(p.state)).length, offline = rows.length - online - calling;
      $('#main').innerHTML = '<h1>Live status</h1><p class="sub">' + (st.engine.state === 'ok' ? esc(st.engine.version.replace(/ built by.*$/, '')) + ' running' : '<span class="pill bad">engine unreachable</span> ' + esc(st.engine.error || '')) + ' &middot; applied version ' + esc(st.appliedVersion == null ? 'none' : st.appliedVersion) + (st.pending ? ' <span class="pill warn">changes not yet applied</span>' : '') + ' &middot; refreshes every 10 s</p>' +
        '<div class="tiles four"><div class="tile' + (online ? ' on' : '') + '">' + icon('check') + '<div class="n">' + online + '</div><div class="l">Online</div></div><div class="tile' + (calling ? ' warn' : '') + '">' + icon('phone') + '<div class="n">' + calling + '</div><div class="l">On a call</div></div><div class="tile">' + icon('clock') + '<div class="n">' + offline + '</div><div class="l">Offline</div></div><div class="tile">' + icon('layers') + '<div class="n">' + (st.engine.activeCalls == null ? '?' : st.engine.activeCalls) + '</div><div class="l">Active calls</div></div></div>' +
        '<div class="card">' + (rows.length ? '<table class="grid"><thead><tr><th>Number</th><th>Name</th><th>Department</th><th>Status</th><th>Phone address</th><th class="right">Response (ms)</th></tr></thead><tbody>' +
          rows.map(p => { const cls = onCall(p.state) ? 'call' : p.registered ? 'on' : 'off'; return '<tr class="' + (cls === 'on' ? 's-ok' : cls === 'call' ? 's-warn' : '') + '"><td class="num"><a href="#/phone/' + esc(p.ext) + '">' + esc(p.ext) + '</a></td><td class="wrap">' + esc(p.name || '') + '</td><td>' + esc(p.dept || '') + '</td><td><span class="state ' + cls + '">' + (cls === 'call' ? 'On a call' : cls === 'on' ? 'Online' : 'Offline') + '</span></td><td class="mono muted">' + esc(p.host || '') + '</td><td class="right mono">' + (p.rtt == null ? '' : p.rtt.toFixed(0)) + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="empty">Nothing applied to the engine yet.</div>') + '</div>';
    };
    draw();
    S.liveTimer = setInterval(async () => { if (S.page !== 'live') return clearInterval(S.liveTimer); S.status = await api('GET', '/api/status').catch(() => S.status); draw(); }, 10000);
  }

  // ---------------------------------------------------------------- users
  async function renderUsers() {
    let users = [];
    try { users = await api('GET', '/api/users'); } catch (e) { toast(e.message, 'bad'); }
    const ROLE_NAMES = ['phone', 'viewer', 'editor', 'admin'];
    $('#main').innerHTML = '<h1>Users</h1><p class="sub">Phone uses only their own browser phone. Viewer sees the directory. Editor adds and changes phones and presses Apply. Admin also manages departments, users and first-time setup details. Anyone with a linked extension can use the browser phone at /phone; that extension must be a "PMC browser phone".</p>' +
      '<div class="grid2"><div class="card"><h3>' + icon('users') + 'Who can sign in</h3><table class="grid"><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Created</th><th></th></tr></thead><tbody>' +
      users.map(u => '<tr' + (u.disabled ? ' style="opacity:.6"' : '') + '><td>' + esc(u.name) + (u.disabled ? ' <span class="pill">disabled</span>' : '') + (u.name === S.me.name ? ' <span class="pill live">you</span>' : '') + '</td><td><select data-role="' + esc(u.name) + '"' + (u.name === S.me.name ? ' disabled' : '') + ' style="width:auto">' + ROLE_NAMES.map(r => '<option' + (r === u.role ? ' selected' : '') + '>' + r + '</option>').join('') + '</select></td>' +
        '<td><input data-ext="' + esc(u.name) + '" value="' + esc(u.ext || '') + '" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="none" aria-label="Linked extension for ' + esc(u.name) + '" style="width:6.5em"></td><td class="muted">' + esc((u.createdAt || '').slice(0, 10)) + '</td>' +
        '<td class="right"><button class="ghost small" data-reset="' + esc(u.name) + '">' + icon('lock') + 'Reset password</button> ' + (u.name === S.me.name ? '' : '<button class="ghost small" data-toggle="' + esc(u.name) + '" data-dis="' + (u.disabled ? '0' : '1') + '">' + (u.disabled ? 'Enable' : 'Disable') + '</button>') + '</td></tr>').join('') + '</tbody></table></div>' +
      '<div class="card"><h3>' + icon('plus') + 'Add a user</h3><form id="uf"><div class="fields"><div class="field"><label>Name (lower case)</label><input name="name" required pattern="[a-z][a-z0-9._-]{1,31}" placeholder="maria.santos"></div><div class="field"><label>Role</label><select name="role"><option>phone</option><option selected>viewer</option><option>editor</option><option>admin</option></select></div>' +
      '<div class="field"><label>Linked extension (browser phone, optional)</label><input name="ext" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="e.g. 1201"></div>' +
      '<div class="field"><label>Temporary password (10+ characters)</label><input name="password" type="password" required minlength="10" autocomplete="new-password"></div></div><div class="actions"><button class="primary" type="submit">' + icon('plus') + 'Add user</button></div></form></div></div>';
    $$('[data-role]').forEach(s => s.onchange = async () => { try { await api('PUT', '/api/users/' + s.dataset.role, { role: s.value }); toast('Role saved', 'ok'); } catch (e) { toast(e.message, 'bad'); renderUsers(); } });
    $$('[data-ext]').forEach(i => i.onchange = async () => { try { await api('PUT', '/api/users/' + i.dataset.ext, { ext: i.value.trim() }); toast(i.value.trim() ? 'Linked to ' + i.value.trim() : 'Phone unlinked', 'ok'); } catch (e) { toast(e.message, 'bad'); renderUsers(); } });
    $$('[data-reset]').forEach(b => b.onclick = async () => { const p = prompt('New temporary password for ' + b.dataset.reset + ' (10+ characters)'); if (!p) return; try { await api('PUT', '/api/users/' + b.dataset.reset, { password: p }); toast('Password reset', 'ok'); } catch (e) { toast(e.message, 'bad'); } });
    $$('[data-toggle]').forEach(b => b.onclick = async () => { try { await api('PUT', '/api/users/' + b.dataset.toggle, { disabled: b.dataset.dis === '1' }); renderUsers(); } catch (e) { toast(e.message, 'bad'); } });
    $('#uf').onsubmit = async ev => { ev.preventDefault(); const f = ev.target; try { await api('POST', '/api/users', { name: f.name.value, role: f.role.value, password: f.password.value, ext: f.ext.value.trim() }); toast('User added', 'ok'); renderUsers(); } catch (e) { toast(e.message, 'bad'); } };
  }

  function renderPassword() {
    $('#main').innerHTML = '<div class="login"><div class="card"><h2>Change your password</h2><form id="cp"><div><label>Current password</label><input name="current" type="password" required autocomplete="current-password"></div><div><label>New password (10+ characters)</label><input name="next" type="password" required minlength="10" autocomplete="new-password"></div>' +
      '<div class="actions"><a class="btn ghost" href="#/overview">Cancel</a><button class="primary" type="submit">Change</button></div></form></div></div>';
    $('#cp').onsubmit = async ev => { ev.preventDefault(); const f = ev.target; try { await api('POST', '/api/password', { current: f.current.value, next: f.next.value }); toast('Password changed', 'ok'); location.hash = '#/overview'; } catch (e) { toast(e.message, 'bad'); } };
  }

  // ---------------------------------------------------------------- history
  async function renderHistory() {
    let rows = [];
    try { rows = await api('GET', '/api/audit?limit=400'); } catch (e) { toast(e.message, 'bad'); }
    const actions = Array.from(new Set(rows.map(r => r.action))).sort();
    const draw = (filter) => {
      const list = rows.filter(r => !filter || r.action === filter);
      $('#hist').innerHTML = list.length ? '<table class="grid"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th><th class="right">Version</th></tr></thead><tbody>' +
        list.map(r => '<tr><td class="mono muted">' + esc((r.at || '').replace('T', ' ').slice(0, 19)) + '</td><td>' + esc(r.who) + '</td><td>' + esc(r.action) + '</td><td class="wrap">' + esc(r.detail) + '</td><td class="right">' + esc(r.version == null ? '' : r.version) + '</td></tr>').join('') + '</tbody></table>' : '<div class="empty">Nothing yet.</div>';
    };
    $('#main').innerHTML = '<h1>History</h1><p class="sub">Every change, who made it and when. Newest first.</p><div class="card"><form class="toolbar" onsubmit="return false"><div><label>Show</label><select id="hf"><option value="">Everything</option>' + actions.map(a => '<option>' + esc(a) + '</option>').join('') + '</select></div><div class="wide"></div><div><span class="muted">' + rows.length + ' entries</span></div></form></div><div class="card" id="hist"></div>';
    $('#hf').onchange = () => draw($('#hf').value); draw('');
  }

  // ---------------------------------------------------------------- the palette
  function openPalette() {
    const dlg = $('#pal'); if (!dlg.showModal) return; dlg.showModal(); const q = $('#pal-q'); q.value = ''; q.focus(); drawPalette('');
  }
  function drawPalette(query) {
    const q = query.toLowerCase().trim(); const items = [];
    PAGES.filter(p => !p.role || can(p.role)).forEach(p => items.push({ sect: 'Pages', icon: p.icon, label: p.label, why: '', href: '#/' + p.key }));
    if (can('editor')) { items.push({ sect: 'Do', icon: 'plus', label: 'New phone', why: 'n', href: '#/phone/new' }); items.push({ sect: 'Do', icon: 'check', label: 'Apply changes', why: 'generate and reload the engine', action: () => applyChanges(null) }); }
    (S.dir ? S.dir.extensions : []).forEach(e => items.push({ sect: 'Numbers', icon: 'phone', label: e.ext + '  ' + e.name, why: e.dept + (e.mac ? ' · ' + e.mac : ''), href: '#/phone/' + e.ext, text: (e.ext + ' ' + e.name + ' ' + e.dept + ' ' + e.mac).toLowerCase() }));
    const hits = items.filter(i => !q || (i.text || (i.label + ' ' + i.why).toLowerCase()).includes(q)).slice(0, 40);
    let sect = '';
    $('#pal-list').innerHTML = hits.map((i, n) => (i.sect !== sect ? (sect = i.sect, '<div class="sect">' + esc(i.sect) + '</div>') : '') + '<a href="' + (i.href || '#') + '" data-n="' + n + '" class="' + (n === 0 ? 'cur' : '') + '">' + icon(i.icon) + '<span>' + esc(i.label) + '</span><span class="why">' + esc(i.why) + '</span></a>').join('') || '<div class="empty">Nothing matches.</div>';
    $$('#pal-list a').forEach((a, n) => a.onclick = ev => { ev.preventDefault(); $('#pal').close(); const i = hits[n]; if (i.action) i.action(); else location.hash = i.href; });
  }
  $('#pal-q').oninput = () => drawPalette($('#pal-q').value);
  $('#pal-q').onkeydown = ev => {
    const links = $$('#pal-list a'); let cur = links.findIndex(a => a.classList.contains('cur'));
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); if (!links.length) return; links[cur] && links[cur].classList.remove('cur'); cur = (cur + (ev.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length; links[cur].classList.add('cur'); links[cur].scrollIntoView({ block: 'nearest' }); }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (links[cur]) links[cur].click(); }
  };
  $('#pal').addEventListener('click', ev => { if (ev.target.id === 'pal') $('#pal').close(); });

  // ---------------------------------------------------------------- keyboard
  const inField = ev => { const t = ev.target; return t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); };
  d.addEventListener('keydown', ev => {
    if (!S.me) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openPalette(); return; }
    if (ev.key === 'Escape') { $('#keys').classList.add('hidden'); if ($('#pal').open) $('#pal').close(); return; }
    if (inField(ev) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (S.pendingG) { S.pendingG = false; const p = PAGES.find(x => x.keyb === ev.key && (!x.role || can(x.role))); if (p) location.hash = '#/' + p.key; return; }
    switch (ev.key) {
      case 'n': if (can('editor')) location.hash = '#/phone/new'; break;
      case '/': ev.preventDefault(); openPalette(); break;
      case 't': toggleTheme(); break;
      case '?': $('#keys').classList.toggle('hidden'); break;
      case 'g': S.pendingG = true; setTimeout(() => { S.pendingG = false; }, 1200); break;
    }
  });

  // ---------------------------------------------------------------- boot
  async function boot() {
    applyPrefs();
    try { S.me = await api('GET', '/api/me'); } catch (e) { return; }
    if (S.me.role === 'phone') { location.replace('/phone'); return; }
    await loadAll(); renderShell(); route();
  }
  renderLogin();
  boot();
})();
