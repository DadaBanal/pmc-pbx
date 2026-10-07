'use strict';
/* PMC Phones - the admin screen. Plain browser JavaScript, no framework. Talks to /api/ on the same origin. */
(function () {
  const S = { me: null, dir: null, status: null, view: 'phones', search: '', liveTimer: null };
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MODELS = { T31P: 'Yealink T31P desk phone', T33G: 'Yealink T33G desk phone', softphone: 'Software phone', none: 'No phone yet' };

  async function api(method, path, body) {
    const opt = { method, headers: { 'X-PMC-PBX': '1' }, credentials: 'same-origin' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(path, opt);
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (r.status === 401 && path !== '/api/login') { S.me = null; renderLogin(); throw new Error('Please sign in'); }
    if (!r.ok) throw new Error((data && data.error) || ('request failed (' + r.status + ')'));
    return data;
  }

  function toast(msg, kind) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + (kind || '');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), kind === 'bad' ? 7000 : 3500);
  }
  function modal(html) { $('#modalCard').innerHTML = html; $('#modal').classList.remove('hidden'); }
  function closeModal() { $('#modal').classList.add('hidden'); $('#modalCard').innerHTML = ''; }
  const can = role => S.me && ({ viewer: 1, editor: 2, admin: 3 }[S.me.role] || 0) >= ({ viewer: 1, editor: 2, admin: 3 }[role]);

  // ---------------------------------------------------------------- shell
  async function boot() {
    try { S.me = await api('GET', '/api/me'); } catch (e) { return; }
    await loadAll();
    renderShell();
    show(S.view);
  }

  async function loadAll() {
    S.dir = await api('GET', '/api/directory');
    S.status = await api('GET', '/api/status').catch(() => null);
    renderChips();
  }

  function renderShell() {
    $('#nav').classList.remove('hidden');
    document.querySelectorAll('#nav button').forEach(b => {
      b.classList.toggle('hidden', !!b.dataset.role && !can(b.dataset.role));
      b.onclick = () => show(b.dataset.view);
    });
    $('#who').innerHTML = esc(S.me.name) + ' <span class="muted">(' + esc(S.me.role) + ')</span> <button class="btn small" id="pw">Change password</button> <button class="btn small" id="out">Sign out</button>';
    $('#out').onclick = async () => { await api('POST', '/api/logout'); location.reload(); };
    $('#pw').onclick = passwordDialog;
  }

  function renderChips() {
    const c = $('#chips'); const st = S.status;
    if (!st) { c.innerHTML = '<span class="chip bad">Status unavailable</span>'; return; }
    const eng = st.engine.state === 'ok' ? '<span class="chip ok">Engine running</span>' : '<span class="chip bad">Engine unreachable</span>';
    const pend = st.pending ? '<span class="chip warn">Changes not yet applied</span>' : '<span class="chip ok">All changes applied</span>';
    const reg = '<span class="chip">' + st.registered + ' phone' + (st.registered === 1 ? '' : 's') + ' online</span>';
    const cert = st.certDaysLeft < 30 ? '<span class="chip warn">Certificate: ' + st.certDaysLeft + ' days left</span>' : '';
    c.innerHTML = eng + pend + reg + cert;
  }

  function show(view) {
    S.view = view;
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    clearInterval(S.liveTimer);
    ({ phones: renderPhones, departments: renderDepartments, live: renderLive, users: renderUsers, history: renderHistory }[view] || renderPhones)();
  }

  // ---------------------------------------------------------------- sign in
  function renderLogin() {
    $('#nav').classList.add('hidden'); $('#chips').innerHTML = ''; $('#who').innerHTML = '';
    $('#main').innerHTML = '<div class="card login"><h1>Sign in</h1><p class="help">PMC Phones, the hospital telephone directory and phone setup.</p>' +
      '<form id="login"><div class="field"><label>Name</label><input name="name" autocomplete="username" required autofocus></div>' +
      '<div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>' +
      '<div class="actions"><button class="btn primary" type="submit">Sign in</button></div></form></div>';
    $('#login').onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target;
      try { S.me = await api('POST', '/api/login', { name: f.name.value, password: f.password.value }); await loadAll(); renderShell(); show('phones'); }
      catch (e) { toast(e.message, 'bad'); }
    };
  }

  // ---------------------------------------------------------------- phones
  function renderPhones() {
    const q = S.search.toLowerCase();
    const rows = S.dir.extensions.filter(e => !q || [e.ext, e.name, e.dept, e.mac, e.site].join(' ').toLowerCase().includes(q))
      .sort((a, b) => a.ext.localeCompare(b.ext));
    const live = new Map(((S.status && S.status.endpoints) || []).map(p => [p.ext, p]));
    const stateOf = e => { const p = live.get(e.ext); if (!p) return '<span class="state off">Not applied</span>'; if (/in use|ringing|busy/i.test(p.state)) return '<span class="state call">On a call</span>'; return p.registered ? '<span class="state on">Online</span>' : '<span class="state off">Offline</span>'; };
    $('#main').innerHTML = '<div class="card"><div class="toolbar"><input type="search" id="q" placeholder="Search by number, name, department or phone" value="' + esc(S.search) + '">' +
      (can('editor') ? '<button class="btn primary" id="add">Add a phone</button>' : '') +
      (can('editor') ? '<button class="btn" id="apply"' + (S.status && !S.status.pending ? ' disabled' : '') + '>Apply changes</button>' : '') + '</div>' +
      (rows.length ? '<table><thead><tr><th class="num">Number</th><th>Name on the phone</th><th>Department</th><th>Phone</th><th>Voicemail</th><th>Status</th><th></th></tr></thead><tbody>' +
        rows.map(e => '<tr><td class="num mono">' + esc(e.ext) + '</td><td>' + esc(e.name) + '</td><td>' + esc(e.dept) + (e.site !== 'PMC' ? ' <span class="muted">(' + esc(e.site) + ')</span>' : '') + '</td>' +
          '<td>' + esc(MODELS[e.model] || e.model) + (e.mac ? ' <span class="mono muted">' + esc(e.mac) + '</span>' : '') + '</td><td>' + (e.voicemail ? 'Yes' : 'No') + '</td><td>' + stateOf(e) + '</td>' +
          '<td class="right">' + (can('editor') ? '<button class="btn small" data-edit="' + esc(e.ext) + '">Edit</button> <button class="btn small danger" data-del="' + esc(e.ext) + '">Remove</button>' : '') + '</td></tr>').join('') +
        '</tbody></table>' : '<div class="empty">No phones yet. Add the first one.</div>') + '</div>';
    $('#q').oninput = ev => { S.search = ev.target.value; renderPhones(); $('#q').focus(); const v = $('#q').value; $('#q').setSelectionRange(v.length, v.length); };
    if ($('#add')) $('#add').onclick = () => phoneForm(null);
    if ($('#apply')) $('#apply').onclick = applyChanges;
    document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => phoneForm(S.dir.extensions.find(e => e.ext === b.dataset.edit)));
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => removePhone(b.dataset.del));
  }

  async function applyChanges() {
    const btn = $('#apply'); if (btn) { btn.disabled = true; btn.textContent = 'Applying...'; }
    try {
      const r = await api('POST', '/api/apply');
      toast('Applied version ' + r.manifest.directoryVersion + ': ' + r.manifest.extensions + ' numbers, ' + r.manifest.phones + ' phones. Engine reloaded.', 'ok');
    } catch (e) { toast('Not applied: ' + e.message, 'bad'); }
    await loadAll(); renderPhones();
  }

  async function removePhone(ext) {
    const e = S.dir.extensions.find(x => x.ext === ext);
    if (!confirm('Remove ' + ext + ' ' + e.name + '? The phone stops working at the next Apply.')) return;
    try { await api('DELETE', '/api/extensions/' + ext); toast('Removed ' + ext + '. Press Apply changes when ready.'); await loadAll(); renderPhones(); }
    catch (err) { toast(err.message, 'bad'); }
  }

  function phoneForm(e) {
    const isNew = !e;
    e = e || { ext: '', name: '', dept: (S.dir.departments[0] || {}).name || '', site: 'PMC', model: 'T31P', mac: '', voicemail: true, keys: [], notes: '' };
    const depts = S.dir.departments.map(d => '<option' + (d.name === e.dept ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('');
    const others = S.dir.extensions.filter(x => x.ext !== e.ext).sort((a, b) => a.ext.localeCompare(b.ext));
    const keyRow = (k, i) => '<div class="keyrow"><select data-k="type"><option value="blf"' + (k.type === 'blf' ? ' selected' : '') + '>Watch and dial</option><option value="speed"' + (k.type === 'speed' ? ' selected' : '') + '>Dial only</option></select>' +
      '<select data-k="ext">' + others.map(o => '<option value="' + esc(o.ext) + '"' + (o.ext === k.ext ? ' selected' : '') + '>' + esc(o.ext + ' ' + o.name) + '</option>').join('') + '</select>' +
      '<input data-k="label" placeholder="Label on the button (optional)" value="' + esc(k.label || '') + '"><button class="btn small danger" type="button" data-delkey="' + i + '">Remove</button></div>';
    modal('<h2>' + (isNew ? 'Add a phone' : 'Edit ' + esc(e.ext) + ' ' + esc(e.name)) + '</h2><form id="pf">' +
      '<div class="grid2"><div class="field"><label>Department</label><select name="dept">' + depts + '</select></div>' +
      '<div class="field"><label>Extension number' + (isNew ? ' (next free is filled in; change if needed)' : '') + '</label><input name="ext" class="mono" value="' + esc(e.ext) + '" pattern="[1-9][0-9]{3}" maxlength="4"' + (isNew ? '' : ' readonly') + '></div>' +
      '<div class="field"><label>Name shown on the phone and in the directory</label><input name="name" value="' + esc(e.name) + '" maxlength="40" required></div>' +
      '<div class="field"><label>Site</label><select name="site"><option' + (e.site === 'PMC' ? ' selected' : '') + '>PMC</option><option' + (e.site === 'JRBY' ? ' selected' : '') + '>JRBY</option></select></div>' +
      '<div class="field"><label>Phone</label><select name="model">' + Object.keys(MODELS).map(m => '<option value="' + m + '"' + (m === e.model ? ' selected' : '') + '>' + MODELS[m] + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Desk phone serial number (MAC, on the sticker under the phone)</label><input name="mac" class="mono" value="' + esc(e.mac) + '" placeholder="00:15:65:xx:xx:xx"></div></div>' +
      '<div class="field check"><input type="checkbox" name="voicemail" id="vm"' + (e.voicemail ? ' checked' : '') + '><label for="vm" style="margin:0">Voicemail on this number</label></div>' +
      '<div class="field"><label>Buttons on the phone (watch a colleague, or dial them with one press)</label><div class="keys" id="keys">' + e.keys.map(keyRow).join('') + '</div><button class="btn small" type="button" id="addkey">Add a button</button></div>' +
      '<div class="field"><label>Notes (for ICT)</label><input name="notes" value="' + esc(e.notes) + '"></div>' +
      '<div class="actions">' + (!isNew && can('admin') ? '<button class="btn" type="button" id="secrets">First-time setup details</button>' : '') + '<button class="btn" type="button" id="cancel">Cancel</button><button class="btn primary" type="submit">Save</button></div>' +
      '<div id="secretbox"></div></form>');
    const f = $('#pf');
    const keys = () => Array.from(document.querySelectorAll('#keys .keyrow')).map(r => ({ type: r.querySelector('[data-k=type]').value, ext: r.querySelector('[data-k=ext]').value, label: r.querySelector('[data-k=label]').value }));
    const wireKeys = () => document.querySelectorAll('[data-delkey]').forEach(b => b.onclick = () => { b.closest('.keyrow').remove(); });
    wireKeys();
    $('#addkey').onclick = () => { if (!others.length) return toast('Add other numbers first', 'bad'); $('#keys').insertAdjacentHTML('beforeend', keyRow({ type: 'blf', ext: others[0].ext, label: '' }, Date.now())); wireKeys(); };
    $('#cancel').onclick = closeModal;
    if (isNew) {
      const next = async () => { try { const r = await api('GET', '/api/extensions/next?dept=' + encodeURIComponent(f.dept.value)); f.ext.value = r.ext || ''; } catch (err) { /* keep what is there */ } };
      f.dept.onchange = next; next();
    }
    if ($('#secrets')) $('#secrets').onclick = async () => {
      try {
        const r = await api('GET', '/api/extensions/' + e.ext + '/provisioning');
        $('#secretbox').innerHTML = '<div class="secret"><b>First-time setup for this phone</b> (shown to administrators only, and recorded in History)<br>' +
          (r.mac ? 'Provisioning address: <span class="mono">' + esc(r.url) + '</span><br>User name: <span class="mono">' + esc(r.username) + '</span><br>Password: <span class="mono">' + esc(r.password || '(created at the next Apply)') + '</span><br>' : 'No desk phone MAC on this number yet.<br>') +
          'Phone account password (software phones): <span class="mono">' + esc(r.sipPassword || '(created at the next Apply)') + '</span></div>';
      } catch (err) { toast(err.message, 'bad'); }
    };
    f.onsubmit = async ev => {
      ev.preventDefault();
      const body = { ext: f.ext.value.trim(), name: f.name.value, dept: f.dept.value, site: f.site.value, model: f.model.value, mac: f.mac.value, voicemail: f.voicemail.checked, keys: keys(), notes: f.notes.value };
      try {
        if (isNew) { const r = await api('POST', '/api/extensions', body); toast('Added ' + r.ext + '. Press Apply changes when ready.'); }
        else { await api('PUT', '/api/extensions/' + e.ext, body); toast('Saved ' + e.ext + '. Press Apply changes when ready.'); }
        closeModal(); await loadAll(); renderPhones();
      } catch (err) { toast(err.message, 'bad'); }
    };
  }

  // ---------------------------------------------------------------- departments
  function renderDepartments() {
    const used = name => S.dir.extensions.filter(e => e.dept === name).length;
    const ro = !can('admin');
    $('#main').innerHTML = '<div class="card"><h1>Departments and number ranges</h1><p class="help">Each department owns a block of four-digit numbers. New phones take the next free number in their department.</p>' +
      '<table><thead><tr><th>Department</th><th class="num">From</th><th class="num">To</th><th class="num">Numbers in use</th><th></th></tr></thead><tbody id="drows">' +
      S.dir.departments.map(d => drow(d, used(d.name), ro)).join('') + '</tbody></table>' +
      (ro ? '' : '<div class="actions"><button class="btn" id="adddept">Add a department</button><button class="btn primary" id="savedepts">Save departments</button></div>') + '</div>';
    if (ro) return;
    const wire = () => document.querySelectorAll('[data-deldept]').forEach(b => b.onclick = () => b.closest('tr').remove());
    wire();
    $('#adddept').onclick = () => { $('#drows').insertAdjacentHTML('beforeend', drow({ name: '', from: '', to: '' }, 0, false)); wire(); };
    $('#savedepts').onclick = async () => {
      const departments = Array.from(document.querySelectorAll('#drows tr')).map(r => ({ name: r.querySelector('[data-d=name]').value, from: Number(r.querySelector('[data-d=from]').value), to: Number(r.querySelector('[data-d=to]').value) }));
      try { await api('PUT', '/api/departments', { departments }); toast('Departments saved'); await loadAll(); renderDepartments(); } catch (e) { toast(e.message, 'bad'); }
    };
  }
  function drow(d, n, ro) {
    const i = (k, v, cls) => ro ? '<span class="' + (cls || '') + '">' + esc(v) + '</span>' : '<input data-d="' + k + '" value="' + esc(v) + '" class="' + (cls || '') + '">';
    return '<tr><td>' + i('name', d.name) + '</td><td class="num">' + i('from', d.from, 'mono') + '</td><td class="num">' + i('to', d.to, 'mono') + '</td><td class="num">' + n + '</td><td class="right">' + (ro ? '' : '<button class="btn small danger" data-deldept>Remove</button>') + '</td></tr>';
  }

  // ---------------------------------------------------------------- live status
  async function renderLive() {
    const draw = () => {
      const st = S.status;
      if (!st) { $('#main').innerHTML = '<div class="card"><div class="empty">Status unavailable</div></div>'; return; }
      const rows = st.endpoints.slice().sort((a, b) => a.ext.localeCompare(b.ext));
      $('#main').innerHTML = '<div class="card"><h1>Live status</h1><p class="help">Engine: ' + (st.engine.state === 'ok' ? esc(st.engine.version) : 'unreachable (' + esc(st.engine.error) + ')') +
        ' &middot; Active calls: ' + (st.engine.activeCalls == null ? '?' : st.engine.activeCalls) + ' &middot; Applied version ' + esc(st.appliedVersion) + (st.pending ? ' (directory is at ' + st.directoryVersion + ', not yet applied)' : '') +
        ' &middot; Certificate ' + st.certDaysLeft + ' days left &middot; refreshes every 10 s</p>' +
        (rows.length ? '<table><thead><tr><th class="num">Number</th><th>Name</th><th>Department</th><th>Status</th><th>Phone address</th><th class="num">Response (ms)</th></tr></thead><tbody>' +
          rows.map(p => '<tr><td class="num mono">' + esc(p.ext) + '</td><td>' + esc(p.name || '') + '</td><td>' + esc(p.dept || '') + '</td><td>' + (/in use|ringing|busy/i.test(p.state) ? '<span class="state call">On a call</span>' : p.registered ? '<span class="state on">Online</span>' : '<span class="state off">Offline</span>') + '</td><td class="mono">' + esc(p.host || '') + '</td><td class="num">' + (p.rtt == null ? '' : p.rtt.toFixed(0)) + '</td></tr>').join('') +
          '</tbody></table>' : '<div class="empty">Nothing applied to the engine yet.</div>') + '</div>';
    };
    draw();
    S.liveTimer = setInterval(async () => { if (S.view !== 'live') return clearInterval(S.liveTimer); S.status = await api('GET', '/api/status').catch(() => S.status); renderChips(); draw(); }, 10000);
  }

  // ---------------------------------------------------------------- users
  async function renderUsers() {
    let users = [];
    try { users = await api('GET', '/api/users'); } catch (e) { toast(e.message, 'bad'); }
    $('#main').innerHTML = '<div class="card"><h1>Users of this screen</h1><p class="help">Viewer sees. Editor adds and changes phones and presses Apply. Admin also manages departments, users and first-time setup details.</p>' +
      '<table><thead><tr><th>Name</th><th>Role</th><th>Created</th><th></th></tr></thead><tbody>' +
      users.map(u => '<tr><td>' + esc(u.name) + (u.disabled ? ' <span class="muted">(disabled)</span>' : '') + '</td><td><select data-role="' + esc(u.name) + '"' + (u.name === S.me.name ? ' disabled' : '') + '>' + ['viewer', 'editor', 'admin'].map(r => '<option' + (r === u.role ? ' selected' : '') + '>' + r + '</option>').join('') + '</select></td><td>' + esc((u.createdAt || '').slice(0, 10)) + '</td>' +
        '<td class="right"><button class="btn small" data-reset="' + esc(u.name) + '">Reset password</button> ' + (u.name === S.me.name ? '' : '<button class="btn small" data-toggle="' + esc(u.name) + '" data-dis="' + (u.disabled ? '0' : '1') + '">' + (u.disabled ? 'Enable' : 'Disable') + '</button>') + '</td></tr>').join('') +
      '</tbody></table><h2 style="margin-top:18px">Add a user</h2><form id="uf" class="grid2"><div class="field"><label>Name (lower case)</label><input name="name" required></div><div class="field"><label>Role</label><select name="role"><option>viewer</option><option>editor</option><option>admin</option></select></div>' +
      '<div class="field"><label>Temporary password (10+ characters)</label><input name="password" type="password" required minlength="10"></div><div class="field" style="align-self:end"><button class="btn primary" type="submit">Add user</button></div></form></div>';
    document.querySelectorAll('[data-role]').forEach(s => s.onchange = async () => { try { await api('PUT', '/api/users/' + s.dataset.role, { role: s.value }); toast('Role saved'); } catch (e) { toast(e.message, 'bad'); renderUsers(); } });
    document.querySelectorAll('[data-reset]').forEach(b => b.onclick = async () => { const p = prompt('New temporary password for ' + b.dataset.reset + ' (10+ characters)'); if (!p) return; try { await api('PUT', '/api/users/' + b.dataset.reset, { password: p }); toast('Password reset'); } catch (e) { toast(e.message, 'bad'); } });
    document.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => { try { await api('PUT', '/api/users/' + b.dataset.toggle, { disabled: b.dataset.dis === '1' }); renderUsers(); } catch (e) { toast(e.message, 'bad'); } });
    $('#uf').onsubmit = async ev => { ev.preventDefault(); const f = ev.target; try { await api('POST', '/api/users', { name: f.name.value, role: f.role.value, password: f.password.value }); toast('User added'); renderUsers(); } catch (e) { toast(e.message, 'bad'); } };
  }

  function passwordDialog() {
    modal('<h2>Change your password</h2><form id="cp"><div class="field"><label>Current password</label><input name="current" type="password" required></div><div class="field"><label>New password (10+ characters)</label><input name="next" type="password" required minlength="10"></div>' +
      '<div class="actions"><button class="btn" type="button" id="cancel">Cancel</button><button class="btn primary" type="submit">Change</button></div></form>');
    $('#cancel').onclick = closeModal;
    $('#cp').onsubmit = async ev => { ev.preventDefault(); const f = ev.target; try { await api('POST', '/api/password', { current: f.current.value, next: f.next.value }); closeModal(); toast('Password changed', 'ok'); } catch (e) { toast(e.message, 'bad'); } };
  }

  // ---------------------------------------------------------------- history
  async function renderHistory() {
    let rows = [];
    try { rows = await api('GET', '/api/audit?limit=300'); } catch (e) { toast(e.message, 'bad'); }
    $('#main').innerHTML = '<div class="card"><h1>History</h1><p class="help">Every change, who made it and when. Newest first.</p>' +
      (rows.length ? '<table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th><th class="num">Version</th></tr></thead><tbody>' +
        rows.map(r => '<tr><td class="mono">' + esc((r.at || '').replace('T', ' ').slice(0, 19)) + '</td><td>' + esc(r.who) + '</td><td>' + esc(r.action) + '</td><td>' + esc(r.detail) + '</td><td class="num">' + esc(r.version == null ? '' : r.version) + '</td></tr>').join('') +
        '</tbody></table>' : '<div class="empty">Nothing yet.</div>') + '</div>';
  }

  $('#modal').addEventListener('click', ev => { if (ev.target.id === 'modal') closeModal(); });
  renderLogin();
  boot();
})();
