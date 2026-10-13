# The pilot on a NUC (Dada, 8 Oct 2026: "i plan to run this first on a nuc first as well")

The pilot engine runs on one of the hospital's mini-PCs before the DND-HOST1 VM is built.

**The build PC is `PMCWKS-181566`** (Dada, 13 Oct 2026: "this is the pc to use for the build"), a **BOSGAME
Ecolite Series** mini-PC. What is measured and what is carried over from its twin:

| | | |
|---|---|---|
| Model | BOSGAME Ecolite Series | MEASURED, Windows Settings on the unit |
| Today | domain-joined Windows 11 workstation, DHCP 10.2.3.186, MAC `84:47:09:82:95:95`, RDP answering | MEASURED 13 Oct from DND-SQL01 |
| CPU, RAM | Ryzen 3 5300U, about 13 GB visible to the OS | INFERRED from the identical model `PMCWKS-180441`, measured 2 Sep |
| NICs | **two** Realtek RTL8125 2.5 GbE (`DEV_8125 REV_05`), plus Realtek 8822CE Wi-Fi | INFERRED from the same twin; this unit's MAC is in the same `84:47:09:82:95:xx` block |

Far more than a PBX for 100 phones needs. This unit's own CPU, RAM and disk were not readable remotely - the
workstation firewall passes RPC 135 but not the dynamic ports behind it - so read them off the BIOS screen at
step 2.

## Before the stick goes in

- **This erases a working Windows 11 workstation.** Whoever uses it moves first. Afterwards disable the
  `PMCWKS-181566` computer object in AD, or it sits there stale.
- **Address: `10.2.0.10/22`, static.** The UDM's DHCP pool on the Default network is `10.2.0.16 - 10.2.3.244`
  (MEASURED 13 Oct). 10.2.0.10 is below it, carries no UniFi reservation, and nothing answered for it from the
  gateway. The address this guide used to name, 10.2.2.200, is **inside** the pool and is leased today to
  PMC-NASPMC. A static address inside the pool is exactly the fault the Matrix PBX has right now at 10.2.3.10.
- **Two Ethernet ports.** Plug in **one** cable, so the installer's automatic interface choice cannot pick a
  dead port.

## The one hardware fact that matters

In September the Windows deployment image could not drive the RTL8125 and the whole network-boot plan died on
it. **Linux is different.** Debian 12's own kernel (6.1) drives the RTL8125 with the in-tree `r8169` driver at
1 Gbit/s out of the box; the out-of-tree `r8125` driver is only for 2.5 Gbit/s link speed (MEASURED from a
Debian forum thread of Feb 2025 on Debian 12.9, kernel 6.1.0-31, where the NIC "works fine at 1 Gbps with the
Realtek r8169 driver loaded"). A PBX needs neither 2.5 Gbit/s nor that driver. Expect the NIC to simply work;
if it does not, that is the first thing to report, not to work around.

## Steps

1. **Write the installer to a USB stick.** The Debian image is an isohybrid: write it raw to the stick, do not
   "extract" it (Debian installation guide, 4.3). On Windows, a raw image writer in its DD mode; on Linux,
   `cp debian-12.15.0-amd64-netinst.iso /dev/sdX && sync`. Check the ISO's SHA256 first
   (`cd4462c06aa8892e692c0c4b9c17802f38c8ab8690e85cbfb5ccaa5956e9af17`, read from cdimage.debian.org 7 Oct 2026).
2. **Firmware.** Boot the stick in UEFI mode. Secure Boot can stay on: Debian boots through its signed shim
   (Debian wiki, SecureBoot). Set the SSD as the only disk; the installer will take the whole of it.
3. **Install** by hand with the values in `vm/README.md` section 2 (hostname `pmc-pbx01`, static address,
   SSH server and standard utilities only), or with `vm/preseed.cfg` served from any web server.
4. **First boot**, from DND-SQL01:
   ```
   ssh pmcadmin@10.2.0.10
   sudo apt-get update && sudo apt-get -y dist-upgrade
   sudo apt-get -y install git curl ca-certificates gnupg chrony nftables
   sudo git clone https://github.com/DadaBanal/pmc-pbx.git /opt/pmc-pbx
   ```
   The repo is private: sign in once with a GitHub token when git asks, or copy the tree over `scp` from
   `C:\PMC\dev\pmc-pbx` on DND-SQL01.
5. **Engine:** `sudo /opt/pmc-pbx/asterisk/build-asterisk.sh` (about 6 minutes on a 2-core runner; the Ryzen
   will be quicker). Gate: `asterisk -V` prints 22.11.0.
6. **Application:** the "On the VM" block in `app/README.md`, unchanged. The admin screen then answers on the
   NUC's LAN address, port 8443.
7. **First phones:** two of the four T30P on the same switch; phase 3 of the design.

## What moves to the VM later

Everything: the same scripts build the DND-HOST1 VM, and `/etc/pmc-pbx` plus `/var/lib/pmc-pbx` copy across
whole. The NUC can stay as the spare engine. Nothing about the phones changes except the address behind
`pbx.pmcne.ph` on DND-AD01.
