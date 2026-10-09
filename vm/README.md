# vm/ - PMC-PBX01 on DND-HOST1

## 1. Create the VM

`New-PbxVm-DNDHOST1.ps1` is the same file as `scripts/New-PbxVm-DNDHOST1-20261007.ps1` in the record.
Run it on DND-HOST1, elevated, preview first:

```
.\New-PbxVm-DNDHOST1.ps1 -SwitchName '<the switch that carries 10.2.0.0/22>'
.\New-PbxVm-DNDHOST1.ps1 -SwitchName '<same>' -Apply
```

It refuses to apply unless the Debian 12.15.0 netinst ISO at `S:\ISO\` matches the published SHA256
(`cd4462c06aa8892e692c0c4b9c17802f38c8ab8690e85cbfb5ccaa5956e9af17`, read from cdimage.debian.org on 7 Oct 2026).

ISO: https://cdimage.debian.org/cdimage/archive/12.15.0/amd64/iso-cd/debian-12.15.0-amd64-netinst.iso

## 2. Install Debian from the console

Hyper-V Manager, connect to PMC-PBX01. Either answer the installer by hand with the values below, or at the
boot menu choose *Advanced options > Automated install* and give the preseed URL once `preseed.cfg` is served
from somewhere reachable (the app's HTTPS listener can serve it later; for the first build, by hand is fine).

| Prompt | Value |
|---|---|
| Language, location, locale | English, Philippines, en_US.UTF-8 |
| Hostname, domain | `pmc-pbx01`, `pmcne.ph` |
| Network | static: address `10.2.2.200/22` (confirm free first), gateway `10.2.0.1`, DNS DND-AD01 |
| Root login | disabled; create user `pmcadmin` with a long password kept outside this repo |
| Partitioning | guided, whole disk, LVM, all files in one partition |
| Software | **SSH server** and **standard system utilities** only. No desktop |
| GRUB | yes, to the only disk |

After first boot, from DND-SQL01:

```
ssh pmcadmin@10.2.2.200
sudo apt-get update && sudo apt-get -y dist-upgrade
sudo apt-get -y install git curl ca-certificates gnupg chrony nftables
```

Then clone this repo to `/opt/pmc-pbx` and continue with `asterisk/build-asterisk.sh`.

`preseed.cfg` is a template. It is UNTESTED as of 7 Oct 2026; the first VM build is its test. The password
hash placeholder must be generated on the VM with `openssl passwd -6` and never committed.

## 3. Hyper-V notes (MS Learn, read 7 Oct 2026)

- Debian 12 is a supported Generation 2 guest on Windows Server 2022.
- Secure Boot stays ON with the **Microsoft UEFI Certificate Authority** template; the script sets it.
- The `hyperv-daemons` package gives the host the VM's IP and clean shutdown; Debian installs it when it
  detects Hyper-V. Confirm with `systemctl status hyperv-daemons.hv-kvp-daemon`.
