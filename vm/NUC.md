# The pilot on a NUC (Dada, 8 Oct 2026: "i plan to run this first on a nuc first as well")

**The build PC is `PMCWKS-181566`** (Dada, 13 Oct 2026: "this is the pc to use for the build"), a BOSGAME
Ecolite Series mini-PC that stays a domain-joined Windows 11 Pro workstation. **The pilot engine runs on it as
a Hyper-V guest, `PMC-PBX01`** - built and running since 13 Oct 2026. Bare metal is kept below as the
fallback, not the plan.

Measured on the box itself, 13 Oct 2026 (`docs/pbx-hyperv-vs-baremetal-20261013.md` in the record):

| | |
|---|---|
| OS | Windows 11 Pro 25H2, 10.0.26200. Pro is the edition gate for client Hyper-V; Home cannot run it |
| CPU, RAM | AMD Ryzen 3 5300U, 4 cores / 8 threads; 12.88 GiB usable of 16 GB fitted |
| Disk | C: 475.9 GB |
| NICs | two Realtek 2.5 GbE: `Ethernet` up at 1 Gbit/s (the switch port is gigabit), `Ethernet 2` unplugged |
| Firmware virtualization | enabled |

**Where the engine finally lives is OPEN.** A VM on DND-HOST1 is one option and has never been decided
(Dada's correction, 13 Oct 2026). The guest is built at configuration version 10.0 so that option stays
available; see "Why version 10.0" below.

---

## Path A - Hyper-V guest (the one built)

### Settings, as built on 13 Oct 2026

| Setting | Value |
|---|---|
| Host feature | Hyper-V enabled on the Windows 11 Pro host. **Enabling it reboots the host** |
| Virtual switch | External, `PMC-PBX-External`, bound to the main **`Ethernet`** adapter, shared with the host. The plan to give the guest `Ethernet 2` was dropped |
| VM | `PMC-PBX01`, **Generation 2**, **configuration version 10.0** |
| Memory | **4 GB static** - Dynamic Memory off, so the host cannot balloon it away mid-call |
| vCPU | 2 of 8 |
| Disk | 64 GB VHDX |
| Secure Boot | On, template `MicrosoftUEFICertificateAuthority` (Debian boots through its Microsoft-signed shim) |
| Install media | `debian-12.15.0-amd64-netinst.iso` as the DVD, SHA256 `cd4462c06aa8892e692c0c4b9c17802f38c8ab8690e85cbfb5ccaa5956e9af17` |
| Guest | Debian 12.15, kernel 6.1.0-53, `pmc-pbx01.pmcne.ph`, static **10.2.0.10/22**, gateway 10.2.0.1, DNS 10.10.0.201 |
| Access | key-only SSH as `pmcadmin` from the build PC; root login disabled |

### Why version 10.0

Windows 11 24H2 and later create VMs at **12.0** by default. DND-HOST1 runs Windows Server 2022, whose highest
supported version is **10.0**, and a VM made on a newer Hyper-V cannot be imported on an older one (MS Learn,
*Upgrade virtual machine version in Hyper-V*). Left at the default, the guest could never move to DND-HOST1
without a rebuild. Nothing in this design needs a feature above 10.0.

### Commands, in an elevated PowerShell window on the build PC

Parameters checked against the Hyper-V cmdlet reference on learn.microsoft.com, 13 Oct 2026. `<VM folder>`
and `<ISO path>` are local paths of your choosing.

```
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All      # reboots the host
Get-VMHostSupportedVersion                                                      # 10.0 must be listed

New-VMSwitch -Name PMC-PBX-External -NetAdapterName 'Ethernet' -AllowManagementOS $true
New-VM -Name PMC-PBX01 -Version 10.0 -Generation 2 -MemoryStartupBytes 4GB -Path '<VM folder>' `
       -NewVHDPath '<VM folder>\PMC-PBX01.vhdx' -NewVHDSizeBytes 64GB -Switch PMC-PBX-External
Set-VMMemory    -VMName PMC-PBX01 -DynamicMemoryEnabled $false
Set-VMProcessor -VMName PMC-PBX01 -Count 2
Set-VMFirmware  -VMName PMC-PBX01 -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority
Add-VMDvdDrive  -VMName PMC-PBX01 -Path '<ISO path>\debian-12.15.0-amd64-netinst.iso'
Set-VMFirmware  -VMName PMC-PBX01 -FirstBootDevice (Get-VMDvdDrive -VMName PMC-PBX01)
Start-VM PMC-PBX01
```

Creating the switch moves the host's own IP onto a new `vEthernet (PMC-PBX-External)` adapter, which drops the
host's network for a few seconds. Do it when nothing on the host is mid-transfer.

### Installing the guest unattended

The scripts that did it on 13 Oct are in the record's `scripts/` folder, prefixed `pbx-`:

| Script | What it does |
|---|---|
| `pbx-make-preseed-20261013.ps1` | Generates the SSH key, `authorized_keys`, the preseed and an ACL-protected credentials file in `C:\PMC\pbx-install\`. Prints no secret |
| `pbx-serve-preseed-20261013.ps1` | Serves only those files over HTTP port 8000 to 10.2.0.0/22, logs every request, removes its firewall rule on exit |
| `pbx-vm-keys-20261013.ps1` | Types into the VM console one key at a time. Use its **`-Chars`** mode for the preseed URL, and `-Keys` for menu navigation |
| `pbx-vm-shot-20261013.ps1` | Reads the console back as an image, so each step is checked before the next |

The preseed is `vm/preseed.cfg` in this repo. At the installer: **Advanced options > Automated install**, then
type the preseed URL at the prompt.

**On that path the installer runs its network setup before it fetches the preseed**, so the preseed's network
and hostname answers arrive too late. `vm/preseed.cfg` therefore writes the static address, DNS, hostname and
`/etc/hosts` in its `late_command`. The 13 Oct build fixed the hostname by hand afterwards; the repo preseed now
does it itself (not yet proven on a build).

**Gate (phase 1):** from the build PC, `ssh pmcadmin@10.2.0.10 hostnamectl` shows `pmc-pbx01` and Debian 12.
Passed 13 Oct 2026, 12:57.

### Checkpoints

Take one before every risky step - `Checkpoint-VM -Name PMC-PBX01 -SnapshotName <name>` - and roll back with
`Restore-VMCheckpoint`. **Delete them all before the PBX carries real calls**: a restore after go-live would
roll back voicemail and call records too.

---

## Phase 2 - the engine, on the guest

All commands run in PowerShell **on the build PC**, as the user whose key the guest trusts. Each `ssh` line is
one complete step. The design's phase 2 gate is `asterisk -rx "core show version"` printing 22.11.x.

**2.0 Checkpoint** (elevated): `Checkpoint-VM -Name PMC-PBX01 -SnapshotName phase1-clean-debian`

**2.1 Tools, and a read-only deploy key made on the guest itself.** The private half never leaves the guest.

```
ssh pmcadmin@10.2.0.10 "sudo apt-get update && sudo apt-get install -y git gnupg ca-certificates curl && ssh-keygen -t ed25519 -N '' -C pmc-pbx01-readonly-deploy -f ~/.ssh/pmc_pbx_deploy && cat ~/.ssh/pmc_pbx_deploy.pub"
```

The last line printed is the public key. It is not a secret.

**2.2 Register it on the repository as a read-only deploy key.** Either Dada adds it in GitHub
(DadaBanal/pmc-pbx > Settings > Deploy keys > Add deploy key, title `pmc-pbx01 read-only`, **leave "Allow write
access" unticked**), or, on his word, the DND-SQL01 session adds it through the GitHub API with the credential
already there. Gate: the repository's deploy-key list shows it with `read_only: true`.

**2.3 Pin GitHub's host key, then clone.** The Ed25519 host key below matches both GitHub's published
fingerprint page and its `api.github.com/meta` endpoint (`SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`),
read 13 Oct 2026. Pinning it means the clone cannot be pointed at an impostor.

```
ssh pmcadmin@10.2.0.10 "printf 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n' >> ~/.ssh/known_hosts && printf 'Host github.com\n  IdentityFile ~/.ssh/pmc_pbx_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config && chmod 600 ~/.ssh/config && sudo install -d -o pmcadmin -g pmcadmin /opt/pmc-pbx && git clone git@github.com:DadaBanal/pmc-pbx.git /opt/pmc-pbx && git -C /opt/pmc-pbx log --oneline -1"
```

Gate: the last line printed is the current head of `main` on GitHub.
**Control that must fail:** `ssh pmcadmin@10.2.0.10 "git -C /opt/pmc-pbx push --dry-run origin HEAD:refs/heads/write-test"`
must be refused as read only. If it is not refused, the key can write: delete it and redo 2.2.

**2.4 The Asterisk release key.** `build-asterisk.sh` verifies the tarball's GPG signature and stops if root's
keyring lacks the key - which a fresh Debian always does. CI never meets this because it runs `SKIP_SIG=1`.
The key `F2FC93DB7587BD1FB49E045A5D984BE337191CE7` is confirmed as the Asterisk Development Team's by three
independent sources, 13 Oct 2026: the Ubuntu keyserver's user ID, Debian's Asterisk maintainer ("trust only
upstream team signing key 5D984BE337191CE7"), and the Asterisk community forum. It is fetched from
keyserver.ubuntu.com because keys.openpgp.org did not connect from the hospital network.

```
ssh pmcadmin@10.2.0.10 "curl -fsS 'https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0xF2FC93DB7587BD1FB49E045A5D984BE337191CE7' | sudo -H gpg --import && sudo -H gpg --fingerprint F2FC93DB7587BD1FB49E045A5D984BE337191CE7"
```

Gate: it prints `F2FC 93DB 7587 BD1F B49E  045A 5D98 4BE3 3719 1CE7` and
`Asterisk Development Team <asteriskteam@digium.com>`.

**2.5 Build.** Foreground, logged on the guest; about 6.5 minutes on a 2-core CI runner, so allow 10-15 here.

```
ssh pmcadmin@10.2.0.10 "set -o pipefail; cd /opt/pmc-pbx && sudo -H bash asterisk/build-asterisk.sh 22.11.0 2>&1 | tee ~/build-asterisk-22.11.0.log && echo BUILD-EXIT-0 || echo BUILD-FAILED"
```

**2.6 Pass gate.** Every line must hold.

```
ssh pmcadmin@10.2.0.10 "grep -E 'Matches the pinned SHA256|Signature OK|SKIP_SIG' ~/build-asterisk-22.11.0.log; /usr/sbin/asterisk -V; sudo systemctl start asterisk && sleep 3 && sudo asterisk -rx 'core show version' && sudo asterisk -rx 'timing test'; sudo systemctl stop asterisk"
```

| Check | Pass |
|---|---|
| Build | `BUILD-EXIT-0` printed in 2.5 |
| Verification really ran | the log shows **both** `Matches the pinned SHA256 for 22.11.0.` and `Signature OK.`, and **no** `SKIP_SIG` line |
| Binary | `asterisk -V` prints `Asterisk 22.11.0` |
| Design gate | `core show version` prints `Asterisk 22.11.0` |
| Timing under Hyper-V | `timing test` names the `timerfd` module and reports **49-51 ticks** in about 1000 ms (it asks for 50 per second). Materially fewer means the virtualized-timing concern is real on this host and the pilot should go bare metal |

**Control that must fail - the signature check must tell a good tarball from a tampered one:**

```
ssh pmcadmin@10.2.0.10 "cp /usr/local/src/asterisk-22.11.0.tar.gz /tmp/tampered.tar.gz && echo x >> /tmp/tampered.tar.gz && sudo -H gpg --verify /usr/local/src/asterisk-22.11.0.tar.gz.asc /tmp/tampered.tar.gz; rm -f /tmp/tampered.tar.gz"
```

It must print `BAD signature`. If it prints `Good signature`, the 2.6 "Signature OK" line proves nothing and the
run is void.

**2.7 Checkpoint** (elevated): `Checkpoint-VM -Name PMC-PBX01 -SnapshotName phase2-asterisk-22.11.0`

---

## Phase 3 - the application, then the first call

**3.0 The engine's own config.** `build-asterisk.sh` ends with `make samples`, so `/etc/asterisk` holds Asterisk's
stock `pjsip.conf` and `extensions.conf`. Those carry none of the `#include` lines that pull in the generated
output, so the engine loads but holds **no transport, no endpoint and no `pmc-internal` context**, and Apply
rightly refuses. Found on PMC-PBX01, 13 Oct 2026. The repo's four files replace them: the same four CI installs.
**`ari.conf` stays out.** It is a template with a placeholder password, and the app does not use ARI. Copied as-is,
it puts a working ARI user with a known password on 127.0.0.1:8088, which is what happened on 13 Oct.

This is part of the "On the VM" block in `app/README.md`, after the ownership lines:

```
sudo -u pmcpbx node app/gen.js --conf /etc/pmc-pbx --out /var/lib/pmc-pbx/out
sudo cp asterisk/conf/pjsip.conf asterisk/conf/extensions.conf asterisk/conf/rtp.conf asterisk/conf/http.conf /etc/asterisk/
sudo chown asterisk:asterisk /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf /etc/asterisk/rtp.conf /etc/asterisk/http.conf
sudo systemctl restart asterisk
```

Gate: `sudo asterisk -rx 'pjsip show transports'` lists `transport-tls`, and `sudo grep -c REPLACE-ON-THE-VM
/etc/asterisk/ari.conf` prints 0, or the file is the stock sample with no users.

**3.1 The application:** the rest of the "On the VM" block in `app/README.md`. Two traps, both met on 13 Oct:
- **Never `tls/*.pem` under sudo.** The glob is expanded by your own shell, which cannot read the 0750 directory.
  Name the files.
- The directory is 0750 root:asterisk, so any check of it runs under sudo with absolute paths. A check that reads
  nothing can still "match" two empty results.

Gate: `curl -s https://pbx.pmcne.ph/health` (the provisioning listener, port 443) from the guest and from the build
PC, over TLS with the `*.pmcne.ph` certificate. The admin screen is the other listener, on 8443.

**3.2 First call:** two of the four T30P on the same switch. 1001 dials 1002, audio both ways, SRTP shown in
`pjsip show channelstats` (design section 10).

---

## Path B - bare metal (fallback, not used)

Only if `timing test` fails under Hyper-V. **This erases the Windows 11 workstation** - its domain join, the
Claude session on it and the synced record copy - so whoever uses it moves first, and its `PMCWKS-181566`
computer object is disabled in AD afterwards.

1. Write `debian-12.15.0-amd64-netinst.iso` raw to a USB stick (it is an isohybrid; Debian installation guide
   4.3). Check its SHA256 first.
2. Boot the stick in UEFI mode. Secure Boot can stay on.
3. Install with `vm/preseed.cfg`, changing two lines: `hw-detect/load_firmware` to `true`, and
   `partman-auto/disk` to the NVMe device (normally `/dev/nvme0n1`).
4. Plug in **one** Ethernet cable, so the installer cannot pick the unplugged port.
5. Phase 2 as above, run from any machine holding the key.

The NIC: Debian 12's kernel drives the RTL8125 with the in-tree `r8169` driver at 1 Gbit/s (a Debian forum
thread, Feb 2025, kernel 6.1.0-31); the out-of-tree `r8125` driver is only for 2.5 Gbit/s, which a PBX does not
need. If the NIC does not come up, report it rather than working around it.

---

## If the engine moves later

`/etc/pmc-pbx` and `/var/lib/pmc-pbx` copy across whole, and a version 10.0 guest exports and imports onto a
Server 2022 host as it is. The phones notice nothing except the address behind `pbx.pmcne.ph` on DND-AD01.
**Where it moves, or whether it moves at all, is not decided.**
