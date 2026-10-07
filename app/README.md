# app/ - the PMC PBX application

Two programs today, both Node 22 with built-in modules only.

| File | Role |
|---|---|
| `gen.js` | `directory.json` plus `secrets.json` in, Asterisk includes plus one Yealink file per phone plus `phonebook.xml` out. Creates missing secrets. `--check` validates without writing |
| `server.js` | HTTPS listener: `/prov/<mac>.cfg` with per-MAC basic auth, `/prov/phonebook.xml`, `/health`. Bans a source after repeated failures |
| `pmc-pbx.service` | systemd unit: runs as `pmcpbx`, may bind 443, reads `/etc/pmc-pbx` read-only |
| `sample/` | a sample `config.json` and `directory.json` for development. `sample/secrets/` is created on first run and ignored by git |

## Develop on any machine

```
node app/gen.js --conf app/sample --out /tmp/pmc-pbx-out --check
node app/gen.js --conf app/sample --out /tmp/pmc-pbx-out
```

## On the VM

```
sudo useradd --system --home-dir /var/lib/pmc-pbx --shell /usr/sbin/nologin pmcpbx
sudo mkdir -p /etc/pmc-pbx/secrets /var/lib/pmc-pbx/out
sudo cp app/sample/config.json /etc/pmc-pbx/config.json      # then edit
sudo cp app/sample/directory.json /etc/pmc-pbx/directory.json # then replace with the real list
# certificate and key as /etc/pmc-pbx/secrets/cert.pem and key.pem, mode 0600, owner pmcpbx
sudo chown -R pmcpbx:pmcpbx /etc/pmc-pbx /var/lib/pmc-pbx
sudo chmod 0700 /etc/pmc-pbx/secrets
sudo -u pmcpbx PMC_PBX_CONF=/etc/pmc-pbx node app/gen.js
sudo install -m 0644 app/pmc-pbx.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pmc-pbx
curl -sk https://pbx.pmcne.ph/health
```

Asterisk reads the generated includes because `asterisk/conf/pjsip.conf` and `extensions.conf` carry
`#include /var/lib/pmc-pbx/out/asterisk/pjsip_pmc.conf` and `..._pmc.conf`. After every `gen.js` run:

```
sudo asterisk -rx "pjsip reload" && sudo asterisk -rx "dialplan reload"
```

Asterisk must be able to read `/var/lib/pmc-pbx/out/asterisk/`; the group `pmcpbx` with `asterisk` as a member
is the intended arrangement (phase 3 confirms the exact permissions).

## Not built yet (phase 5)

The admin screen, the ARI live view, reload-on-apply, voicemail-to-email and the directory sync from
`payroll.Employee`. The design and the decisions that are still Dada's are in the record,
`docs/pbx-design-20261007.md`, section 7.
