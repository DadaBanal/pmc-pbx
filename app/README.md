# app/ - the PMC PBX application

Node 22, built-in modules only. One process, two HTTPS listeners on the same certificate.

| Listener | Who reaches it | What it serves |
|---|---|---|
| **public** `listen` (443, forwarded from the internet) | the phones | `/prov/<mac>.cfg` with a per-phone password, `/prov/phonebook.xml`, `/health` |
| **admin** `admin` (8443, LAN address only, never forwarded) | staff with an account | the **PMC Phones** screen and its `/api/` |

## The PMC Phones screen

`public/` is a plain HTML page. No framework, nothing to build.

| View | Who | What a person does there |
|---|---|---|
| Phones | everyone | search; add a phone (department, next free number filled in, name, phone model, MAC, voicemail, buttons); edit; remove; **Apply changes** |
| Departments | admin edits | the four-digit block each department owns; new numbers come from it |
| Live status | everyone | engine version, which phones are online, from which address, active calls; refreshes every 10 s |
| Users | admin | viewer / editor / admin accounts, reset a password, disable an account |
| History | admin | every change, who and when; viewing a phone's first-time password is itself recorded |

Roles: **viewer** sees. **Editor** adds and changes phones and presses Apply. **Admin** also manages departments,
users and first-time setup details. Sessions are HMAC-signed cookies (HttpOnly, Secure, SameSite=Strict); every
write needs the `X-PMC-PBX: 1` header, which the page sends and a cross-site form cannot. Ten failed sign-ins
from one address lock it out for an hour (configurable).

**Apply** validates the directory, creates any missing secrets, writes the Asterisk includes and the phone files,
then runs `pjsip reload` and `dialplan reload` on the engine. The chips at the top say whether the engine is
reachable and whether there are changes not yet applied.

## Files

| File | Role |
|---|---|
| `server.js` | both listeners, the API, `applyChanges()` |
| `gen.js` | command-line generator (same code as Apply, without the reload) |
| `admin.js` | command line: `adduser`, `passwd`, `users`, `check`, `apply` |
| `lib/validate.js` | the directory rules and the next-free-number logic |
| `lib/generate.js` | Asterisk, Yealink and phonebook rendering |
| `lib/store.js` | directory.json with version, history copies (last 50) and the audit trail; secrets.json 0600 |
| `lib/asterisk.js` | reload and live status through `asterisk -rx` |
| `lib/auth.js` | users, scrypt hashes, session tokens |
| `lib/httpx.js` | JSON, cookies, basic auth, static files, the ban list |
| `test/` | `node --test app/test/`: validation, rendering, auth, parsers, and the whole API against a fake engine |
| `sample/` | a sample `config.json` and `directory.json` for development |

## Develop on any machine

```
node --test app/test/
node app/gen.js --conf app/sample --out /tmp/pmc-pbx-out
```

The API test makes a throwaway self-signed certificate with `openssl` and is skipped if `openssl` is absent.

## On the VM

```
sudo useradd --system --home-dir /var/lib/pmc-pbx --shell /usr/sbin/nologin pmcpbx
sudo mkdir -p /etc/pmc-pbx/secrets /etc/pmc-pbx/tls /var/lib/pmc-pbx/out/asterisk /var/lib/pmc-pbx/out/phones
sudo cp app/sample/config.json /etc/pmc-pbx/config.json       # edit: admin.host = the VM's LAN address, asterisk.command = ["sudo","-n","/usr/sbin/asterisk"]
sudo cp app/sample/directory.json /etc/pmc-pbx/directory.json # replace with the real list, or start empty and use the screen
# the wildcard certificate and key as /etc/pmc-pbx/tls/cert.pem and key.pem (both the app and the engine read them)
sudo chown -R pmcpbx:pmcpbx /etc/pmc-pbx /var/lib/pmc-pbx
sudo chmod 0700 /etc/pmc-pbx/secrets
# explicit file names, never tls/*.pem: the glob is expanded by YOUR shell, which cannot read the 0750 directory,
# so it reaches sudo unexpanded or wrong (13 Oct 2026, PMC-PBX01)
sudo chgrp asterisk /etc/pmc-pbx/tls /etc/pmc-pbx/tls/cert.pem /etc/pmc-pbx/tls/key.pem /var/lib/pmc-pbx/out/asterisk
sudo chmod 0750 /etc/pmc-pbx/tls && sudo chmod 0640 /etc/pmc-pbx/tls/cert.pem /etc/pmc-pbx/tls/key.pem
sudo chmod 2750 /var/lib/pmc-pbx/out/asterisk         # setgid: generated includes inherit group asterisk
sudo usermod -aG asterisk pmcpbx
echo 'pmcpbx ALL=(root) NOPASSWD: /usr/sbin/asterisk -rx *' | sudo tee /etc/sudoers.d/pmc-pbx
# the engine's own config: the repo's files carry the #include lines for the generated output. Same four files CI
# installs. ari.conf stays OUT: it is a template with a placeholder password, and the app does not use ARI.
sudo -u pmcpbx node app/gen.js --conf /etc/pmc-pbx --out /var/lib/pmc-pbx/out   # as pmcpbx: root would leave root-owned output
for f in pjsip extensions rtp http; do sudo cp -p /etc/asterisk/$f.conf /etc/asterisk/$f.conf.sample-$(date +%Y%m%d) 2>/dev/null; done
sudo cp asterisk/conf/pjsip.conf asterisk/conf/extensions.conf asterisk/conf/rtp.conf asterisk/conf/http.conf /etc/asterisk/
sudo chown asterisk:asterisk /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf /etc/asterisk/rtp.conf /etc/asterisk/http.conf
sudo systemctl restart asterisk
sudo asterisk -rx 'pjsip show transports' | grep -q 'transport-tls' && echo 'TLS transport loaded' || echo 'TLS transport MISSING'
sudo -u pmcpbx PMC_PBX_CONF=/etc/pmc-pbx node app/admin.js adduser dada admin
sudo install -m 0644 app/pmc-pbx.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pmc-pbx
curl -sk https://pbx.pmcne.ph/health
```

Who reads what: `secrets/` (phone passwords, user hashes, the session key) is the app's alone, 0700. `tls/` is
read by the app for HTTPS and by the engine for SIP over TLS. `out/asterisk/` holds the generated includes
with SIP secrets, group `asterisk`, mode 0640, and the directory is setgid so every regenerated file keeps that
group; the generator also sets the group explicitly. The engine reads them because `asterisk/conf/pjsip.conf`
and `extensions.conf` carry `#include /var/lib/pmc-pbx/out/asterisk/...`.

**Apply verifies, it does not trust.** A reload the engine cannot read says nothing and keeps the old config
(found by CI on 7 Oct 2026). After every reload the app reads `pjsip show endpoints` and
`dialplan show pmc-internal` back and fails the Apply, with the missing numbers named, if the engine does not
hold every extension and hint in the directory. The sudoers line is what lets the screen reload the engine
without running as root.

## Not built yet

Voicemail-to-email, the directory sync from `payroll.Employee`, click-to-dial from the Employee Portal, and
sign-in with the hospital's Microsoft accounts. Decisions still open are listed in the record,
`docs/pbx-design-20261007.md`, section 7.
