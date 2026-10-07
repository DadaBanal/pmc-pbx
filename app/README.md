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
sudo mkdir -p /etc/pmc-pbx/secrets /var/lib/pmc-pbx/out
sudo cp app/sample/config.json /etc/pmc-pbx/config.json       # edit: admin.host = the VM's LAN address, asterisk.command = ["sudo","-n","/usr/sbin/asterisk"]
sudo cp app/sample/directory.json /etc/pmc-pbx/directory.json # replace with the real list, or start empty and use the screen
# certificate and key as /etc/pmc-pbx/secrets/cert.pem and key.pem, owner pmcpbx, mode 0600
sudo chown -R pmcpbx:pmcpbx /etc/pmc-pbx /var/lib/pmc-pbx
sudo chmod 0700 /etc/pmc-pbx/secrets
echo 'pmcpbx ALL=(root) NOPASSWD: /usr/sbin/asterisk -rx *' | sudo tee /etc/sudoers.d/pmc-pbx
sudo -u pmcpbx PMC_PBX_CONF=/etc/pmc-pbx node app/admin.js adduser dada admin
sudo install -m 0644 app/pmc-pbx.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pmc-pbx
curl -sk https://pbx.pmcne.ph/health
```

Asterisk reads the generated includes because `asterisk/conf/pjsip.conf` and `extensions.conf` carry
`#include /var/lib/pmc-pbx/out/asterisk/pjsip_pmc.conf` and `..._pmc.conf`; the `asterisk` user needs read
access to `/var/lib/pmc-pbx/out/asterisk/` (phase 3 settles the group arrangement). The sudoers line is what lets
the screen reload the engine without running as root.

## Not built yet

Voicemail-to-email, the directory sync from `payroll.Employee`, click-to-dial from the Employee Portal, and
sign-in with the hospital's Microsoft accounts. Decisions still open are listed in the record,
`docs/pbx-design-20261007.md`, section 7.
