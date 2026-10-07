'use strict';
// Talk to the engine on the same machine through its command line: reload after a change, read live status.
// cfg.asterisk.command is an argv prefix, e.g. ["/usr/sbin/asterisk"] or ["sudo","-n","/usr/sbin/asterisk"].
const { execFile } = require('child_process');

function run(cfg, cli) {
  const cmd = cfg.asterisk.command;
  return new Promise(resolve => {
    execFile(cmd[0], cmd.slice(1).concat(['-rx', cli]), { timeout: cfg.asterisk.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, cli, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? (err.code === 'ENOENT' ? 'engine command not found' : err.message) : null });
    });
  });
}

async function reload(cfg) {
  const steps = [];
  for (const cli of ['pjsip reload', 'dialplan reload']) {
    const r = await run(cfg, cli);
    steps.push({ cli, ok: r.ok, out: (r.stdout + r.stderr).trim().slice(0, 500) });
    if (!r.ok) return { ok: false, steps, error: r.error };
  }
  return { ok: true, steps };
}

function parseEndpoints(text) {
  const out = [];
  // " Endpoint:  3901/3901                 Not in use    0 of 1"  (the CID part may carry spaces; the state follows a run of 2+ spaces)
  const re = /^\s*Endpoint:\s+(\d{3,6})\/.*?\s{2,}(\S.*?)\s+(\d+) of (\S+)\s*$/;
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (m) out.push({ ext: m[1], state: m[2].trim(), channels: Number(m[3]), max: m[4] });
  }
  return out;
}

function parseContacts(text) {
  const out = [];
  const re = /^\s*Contact:\s+(\d{3,6})\/(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (m) {
      const uri = m[2];
      const host = (/@([^:;>]+)/.exec(uri) || [])[1] || '';
      out.push({ ext: m[1], uri, host, status: m[4], rtt: m[5] === 'nan' ? null : Number(m[5]) });
    }
  }
  return out;
}

async function status(cfg) {
  const v = await run(cfg, 'core show version');
  if (!v.ok) return { engine: 'unreachable', error: v.error, version: null, endpoints: [], contacts: [], activeCalls: null };
  const [ep, ct, ch] = await Promise.all([run(cfg, 'pjsip show endpoints'), run(cfg, 'pjsip show contacts'), run(cfg, 'core show channels count')]);
  const calls = /(\d+) active calls?/.exec(ch.stdout);
  return {
    engine: 'ok',
    version: (v.stdout.split('\n')[0] || '').trim(),
    endpoints: parseEndpoints(ep.stdout),
    contacts: parseContacts(ct.stdout),
    activeCalls: calls ? Number(calls[1]) : null
  };
}

module.exports = { run, reload, status, parseEndpoints, parseContacts };
