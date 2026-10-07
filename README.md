# pmc-pbx

PMC's own IP PBX: Asterisk 22 LTS as the engine, a PMC-written application on top for the directory,
phone provisioning, the admin screen and live status. Internal calling only, no carrier trunk.
Phones provision from anywhere over HTTPS and register over TLS to `pbx.pbx-fqdn` (see `config.json`).

Design, decisions and the build gates live in the PMC record:
`docs/pbx-design-20261007.md` (OneDrive, Documents\Claude). This repo holds the code and the build scripts.
Decisions are not made here; they are made by Dada and filed there.

## Layout

| Path | What |
|---|---|
| `vm/` | The Hyper-V VM build script for DND-HOST1 and the Debian 12 install notes and preseed template |
| `asterisk/` | `build-asterisk.sh` (source build of Asterisk 22 LTS on Debian 12), the systemd unit, base config files |
| `app/` | The PMC application: `gen.js` (directory to Asterisk and phone config), `server.js` (HTTPS provisioning and health), sample directory, systemd unit |
| `phones/` | Yealink notes: RPS, the MAC config file, what the first phone must prove |

## Runtime layout on the VM

| Path | Content | In git |
|---|---|---|
| `/opt/pmc-pbx` | this repo, checked out | yes |
| `/etc/pmc-pbx/config.json` | FQDN, addresses, ports, paths | template only |
| `/etc/pmc-pbx/directory.json` | the source of truth: extensions, names, MACs, keys | no, backed up nightly |
| `/etc/pmc-pbx/secrets/` | `secrets.json`, certificate and key, mode 0600 | **never** |
| `/var/lib/pmc-pbx/out/` | generated Asterisk includes, phone files, phonebook | no, regenerable |
| `/etc/asterisk/` | base configs from `asterisk/conf/` plus `#include` of the generated files | base only |

## Quick start (any machine with Node 22, for development)

```
node app/gen.js --conf app/sample --out /tmp/pmc-pbx-out
```

writes the Asterisk includes, one `<mac>.cfg` per phone and `phonebook.xml` from `app/sample/directory.json`,
creating `app/sample/secrets/secrets.json` with random secrets on first run. `app/sample/secrets/` is ignored by git.

## Rules

- No third-party Node modules. Built-ins only, like every other PMC service.
- No secrets in this repo, in a chat, or in a screenshot. Secrets are generated on the VM and stay there.
- Every change to the live VM goes through `gen.js` and a reload; nobody hand-edits `/etc/asterisk/*_pmc.conf`.
- Label every number MEASURED or INFERRED in docs and commit messages, same as the record.

Built from 7 Oct 2026 for workstream WS47. Licence of the engine: Asterisk is GPL-2.0. This application: PMC internal.
