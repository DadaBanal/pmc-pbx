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
| `admin.js` | command line: `adduser`, `passwd`, `users`, `check`, `apply`, `addext`, `link` |
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
# The app talks to the engine through its control socket, as group asterisk, with NO sudo: pmc-pbx.service runs with
# NoNewPrivileges=true, which blocks sudo outright (14 Oct 2026: Apply from the screen failed with "no new
# privileges" until this). In /etc/asterisk/asterisk.conf, uncomment [files] and set:
#   astctlpermissions = 0660   astctlowner = asterisk   astctlgroup = asterisk   astctl = asterisk.ctl
# and in /etc/pmc-pbx/config.json: "asterisk": { "command": ["/usr/sbin/asterisk"] }
# the engine's own config: the repo's files carry the #include lines for the generated output. Same five files CI
# installs. ari.conf stays OUT: it is a template with a placeholder password, and the app does not use ARI.
sudo -u pmcpbx node app/gen.js --conf /etc/pmc-pbx --out /var/lib/pmc-pbx/out   # as pmcpbx: root would leave root-owned output
for f in pjsip extensions rtp http voicemail; do sudo cp -p /etc/asterisk/$f.conf /etc/asterisk/$f.conf.sample-$(date +%Y%m%d) 2>/dev/null; done
sudo cp asterisk/conf/pjsip.conf asterisk/conf/extensions.conf asterisk/conf/rtp.conf asterisk/conf/http.conf asterisk/conf/voicemail.conf /etc/asterisk/
sudo chown asterisk:asterisk /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf /etc/asterisk/rtp.conf /etc/asterisk/http.conf /etc/asterisk/voicemail.conf
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

## The browser phone (PMC Phone)

Dada, 13 Oct 2026: *"start building softphones with the same theme as the desk"*. Staff call from any PC with no
install, at `https://pbx.pmcne.ph:8443/phone`, in the same theme as this screen and the PSA desk.

| Piece | What it is |
|---|---|
| `public/phone.html`, `phone.js` | the phone screen: dial pad, phone book, recent calls, incoming-call box, mute, hold, keypad tones |
| `public/sip.js` | the SIP user agent, plain JavaScript (SIP over WebSocket, RFC 7118; digest auth with its own MD5). The same file runs in Node for the tests |
| model `webphone` | "PMC browser phone (no install)". Its endpoint uses the `pmc-webrtc` template (`webrtc=yes`, DTLS-SRTP, ICE) on `transport-ws`; desk phones keep `pmc-endpoint` on TLS |
| role `phone` | below viewer: own phone and the phone book only. Any user, any role, can be linked to one extension on the Users page |
| `/api/softphone` | the signed-in user's own extension and its SIP password. Never another's |
| `/ws` | the gate: refused unless the Origin is this site, the session is live, and the user has a linked phone. Then passed to Asterisk's loopback-only `/ws` (`http.conf`), without the cookie |

To give someone a browser phone: add an extension with model **PMC browser phone**, press **Apply changes**, then
on **Users** link their sign-in to that extension (role `phone` for staff who should see nothing else). They open
`/phone`, sign in, allow the microphone once. `asterisk/conf/rtp.conf` must carry `icesupport=yes`.

Proven: `test/sip.test.js` (MD5 against RFC 1321, digest against RFC 2617's worked example, the call flows),
`test/softphone.test.js` (the role, the routes, and the gate refusing no session, a foreign Origin, an unlinked user
and the public listener), and in CI `test/ws-call.js` registers and calls 9197 through the gate on the real engine.
**Not provable without a person:** audio both ways in a real browser. 9196 is an echo test for exactly that.

### As an installed app

Dada, 13 Oct 2026: *"well we need a phone app for this"*. The same page installs as an app, with its own window,
Start menu entry, taskbar icon and the PMC Phone icon, and nothing downloaded from outside. It is not a RemoteApp:
on on-premises RDS, Microsoft documents calling audio as server-side rendered and degraded, and its offload exists
only in Azure Virtual Desktop, Windows 365 and Dev Box.

| Piece | What it does |
|---|---|
| `public/manifest.webmanifest` | name, `/phone` as start and scope, standalone window, three icons (192, 512, 512 maskable) |
| `public/sw.js` | caches nothing (a phone running yesterday's `sip.js` is worse than one that says it is offline); turns a failed page load into a plain "cannot reach the phone system" page |
| `public/icons/` | rendered from an SVG with headless Edge; white handset on the accent gradient |
| `test/pwa.test.js` | the files are well formed and the right sizes, the page links them, the worker scope matches, the server gives them out **before sign-in** (Edge's force-install fetches them signed out), and the worker passes a live page through untouched |

**Getting it:** open `https://phone.pmcne.ph` in Edge on a PC on the Default network, then *Install*. No Group Policy:
Dada, 13 Oct 2026, *"why does it need to be gpo"*. (If it is ever wanted, Edge's `WebAppInstallForceList` installs it
silently and `WebAppSettings` `run_on_os_login` opens it at sign-in; both Windows only.)

### Where it works: any network with internet, and nothing else is exposed

Dada, 14 Oct 2026: *"from now on it should work with any network even mobile networks"*, then *"it should work as
long as there is an internet connection but no backdoors to anything else"*. This REPLACES his 13 Oct ruling, *"only
enable it on the default network"*. `phoneNetworks` is left out of config.json on PMC-PBX01 (the feature stays: when it
is set, the phone site, `/phone`, phone sign-in, `/api/softphone`, `/api/phonebook` and `/ws` answer only those networks).

What makes "any network, no backdoors" true:

| Piece | What it does |
|---|---|
| UDM port forward (Dada makes it in the UniFi UI) | one spare public address, **103.144.157.235**, forwards TCP 443 and UDP 10000-10999 to **10.2.0.11** only. Nothing to 8443, 5061 or 22. Public DNS `phone.pmcne.ph` -> .235 |
| `webrtcPublicAddress` | `"103.144.157.235"`: generated into `rtp_pmc.conf` as `[ice_host_candidates] 10.2.0.11 => 103.144.157.235,include_local_address` (syntax from Asterisk's own configs/samples/rtp.conf.sample), so phones outside are offered the public address and phones inside still go direct |
| webphone endpoints | `deny=0.0.0.0/0.0.0.0`, `permit=127.0.0.1`: a browser phone's password works only through the app's `/ws` gate, never straight on 5061 (CI proves it, with a desk phone on 5061 as the control) |
| host firewall `vm/nftables-pmc-pbx.nft` | in: 10.2.0.11 443 and the audio ports from anywhere; ssh, 8443, provisioning and 5061 from the hospital only. out: audio; the engine to LAN phones; LDAPS to DND-AD01 only; DNS; time; updates and git to the internet only. **No new connection from this box into the LAN**: a compromised PBX is not a way in. Load with `sudo bash vm/firewall.sh apply` (rolls itself back in 5 minutes) and `confirm` once checked |
| sign-in | 5 failures per name in 15 minutes and that name cools down, whatever address it comes from (AD lockout is OFF on this domain, so this is the only cap); 20 per address. The phone site never checks an admin-screen password |

Not yet: a TURN relay for the few networks that block UDP entirely; reconnecting a call in progress when a phone moves
between Wi-Fi and mobile data (the call ends; the phone re-registers on its own).

### The phone site: no port in the address

Dada: *"why still the port"*. `phoneSite` `{ "host": "10.2.0.11", "port": 443, "name": "phone.pmcne.ph" }`, with `listen.host` set to `10.2.0.10` (with
`0.0.0.0` the provisioning listener holds 443 on every address and the phone site cannot start; config refuses it), is a third
listener on its own LAN address, so the address is `https://phone.pmcne.ph`. It serves the phone's files and the phone's
API only: `/` goes to `/phone`, the admin screen's files and admin API answer 404 there, even for an admin. The
internet-facing listener stays alone on 10.2.0.10:443. The wildcard certificate covers the name.

### Phone users: Windows sign-in, their own list

Dada: *"there should be a separate user list that is link to the ad add pmo team on it"*. Anyone who is not an
admin-screen account signs in with their Windows name and password (`jdoe`, `PMCNE\jdoe` or `jdoe@pmcne.ph`).

| Step | What happens |
|---|---|
| password | a simple bind to the domain controller as that person, over LDAPS, on a **pinned** certificate: DND-AD01's is self-signed (`CN=DND-AD01`, to 2031), so the SHA-256 fingerprint in `ad.pin` is the whole trust decision. An empty password is refused before anything is sent (AD treats it as an anonymous bind and says yes) |
| group | `ad.groups` (e.g. `["PMO Team"]`), nested membership included (`LDAP_MATCHING_RULE_IN_CHAIN`), checked at **every** sign-in |
| the list | `phone-users.json`, separate from the admin accounts. First sign-in adds the person with a browser phone in `ad.dept`; the engine is reloaded only if nothing else is waiting, so a sign-in never pushes an editor's unapplied changes live |
| switching off | Users page, *Phone users (Windows sign-in)*: **Switch off** ends their session and closes their open phone connection at once, even while they stay in the group; a sweep every 30 s closes any connection whose session stopped being valid |
| removing | **Remove** takes the person and their browser phone off; *Apply changes* afterwards. An extension someone is linked to cannot be deleted on the Phones page (the next person given that number would otherwise inherit their sign-in) |

`node admin.js phoneuser <windows-name> <display name...>` puts someone on the list ahead of their first sign-in;
`node admin.js phoneusers` lists it. Their password is never stored here: the domain controller checks it each time.

```json
"ad": { "url": "ldaps://10.10.0.201:636", "servername": "DND-AD01.pmcne.ph",
        "pin": "B8:33:06:10:D0:47:96:C1:DE:AB:C4:5C:35:2E:91:C3:7F:4B:79:2F:13:E0:9C:FC:02:D9:F7:FA:54:E8:CC:C2",
        "baseDN": "DC=pmcne,DC=ph", "upnSuffix": "@pmcne.ph", "groups": ["PMO Team"], "dept": "ICT" }
```

Proven by `test/ad.test.js` against `test/fake-dc.js`, a stand-in directory on a pinned certificate: the password
by bind, the group, locked and unknown accounts, an empty password and a wrong certificate that never reach it, the
list, first-sign-in extension, switching off, the phone site's limits and the network rule. Each protection was
broken on purpose once and a test failed.

## Voicemail

Every extension with voicemail on has a mailbox (`voicemail_pmc.conf`, context `[pmc]`, generated on Apply;
`asterisk/conf/voicemail.conf` includes it). Unanswered or busy calls go to it; *97 from your own phone plays your
messages without a PIN (the dialplan uses the authenticated endpoint, not the caller ID). Until 14 Oct 2026 there were
no mailboxes and every unanswered call dropped the caller.

## Not built yet

Voicemail-to-email, the directory sync from `payroll.Employee`, click-to-dial from the Employee Portal, and
sign-in with the hospital's Microsoft accounts. Decisions still open are listed in the record,
`docs/pbx-design-20261007.md`, section 7.
