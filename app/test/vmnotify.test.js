'use strict';
// Voicemail notices to the PMO Teams chat (Dada, 15 Oct 2026: "for now pmo chitchat").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const VM = require('../lib/vmnotify');

const directory = { extensions: [
  { ext: '6666', name: 'PMO Support', dept: 'PMO' },
  { ext: '6000', name: 'PMC Test 1', dept: 'PMO' },
  { ext: '1201', name: 'Corridor West', dept: 'Nursing' }
] };

function msgFile(dir, ext, n, id, callerid, dur) {
  const inbox = path.join(dir, ext, 'INBOX');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'msg' + String(n).padStart(4, '0') + '.txt'),
    ';\n; Message Information file\n;\n[message]\norigmailbox=' + ext + '\ncallerid=' + callerid + '\norigtime=1792055000\nmsg_id=' + id + '\nduration=' + dur + '\n');
}

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcpbx-vm-'));
  const spool = path.join(root, 'spool'); fs.mkdirSync(spool);
  const posts = [];
  let answer = { ok: true, status: 202 };
  const cfg = { dataDir: root, voicemailNotify: { departments: ['PMO'], spoolDir: spool } };
  const make = () => VM.createNotifier(cfg, {
    loadDirectory: () => directory,
    getSecrets: () => ({ voicemailWebhook: 'https://example.invalid/workflows/x' }),
    post: async (url, body) => { posts.push({ url, body }); return answer; }
  });
  return { root, spool, posts, make, fail: v => { answer = v ? { ok: false, status: 500 } : { ok: true, status: 202 }; } };
}

test('the first pass only marks what is already there; nothing old is posted', async () => {
  const r = rig();
  msgFile(r.spool, '6666', 0, 'old-1', '"Old Caller" <3903>', 12);
  const n = r.make();
  const res = await n.tick();
  assert.equal(res.primed, 1); assert.equal(r.posts.length, 0);
  assert.equal((await n.tick()).posted, 0, 'and it stays quiet afterwards');
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('a new PMO voicemail is posted once, as an Adaptive Card with who, for whom, when and how long', async () => {
  const r = rig();
  const n = r.make(); await n.tick();
  msgFile(r.spool, '6666', 0, 'new-1', '"Susan Dolfo" <3908>', 83);
  assert.equal((await n.tick()).posted, 1);
  const body = r.posts[0].body;
  assert.equal(body.type, 'message');
  assert.equal(body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  const c = body.attachments[0].content, text = JSON.stringify(c);
  assert.equal(c.type, 'AdaptiveCard');
  assert.match(text, /New voicemail for 6666 PMO Support/);
  assert.match(text, /Susan Dolfo \(3908\)/);
  assert.match(text, /"1:23"/);
  assert.match(text, /Dial \*97 from 6666/);
  assert.equal((await n.tick()).posted, 0, 'never twice');
  // a restart reads the saved state and does not post it again
  assert.equal((await r.make().tick()).posted, 0, 'not after a restart either');
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('control: a mailbox outside the chosen departments is never posted', async () => {
  const r = rig();
  const n = r.make(); await n.tick();
  msgFile(r.spool, '1201', 0, 'nurse-1', '"Someone" <3903>', 5);
  assert.equal((await n.tick()).posted, 0);
  assert.equal(r.posts.length, 0);
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('a failed post is retried on the next pass, then not again', async () => {
  const r = rig();
  const n = r.make(); await n.tick();
  msgFile(r.spool, '6000', 0, 'retry-1', '"Kevin" <3910>', 9);
  r.fail(true);
  assert.equal((await n.tick()).posted, 0);
  r.fail(false);
  assert.equal((await n.tick()).posted, 1);
  assert.equal((await n.tick()).posted, 0);
  assert.equal(r.posts.length, 2, 'one failed try, one success');
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('the real sender refuses anything but https', async () => {
  assert.equal((await VM.httpsPost('http://example.invalid/x', {})).error, 'not https');
  assert.equal((await VM.httpsPost('not a url', {})).error, 'bad address');
});
