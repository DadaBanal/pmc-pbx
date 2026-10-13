#!/bin/bash
# Load the PMC-PBX01 host firewall safely. Dada, 14 Oct 2026: "no backdoors to anything else".
#
#   sudo bash vm/firewall.sh check     parse the rule file only; changes nothing (the preview)
#   sudo bash vm/firewall.sh apply     back up, load, and arm an automatic rollback in 5 minutes
#   sudo bash vm/firewall.sh confirm   keep it: cancel the rollback, make it load at boot
#   sudo bash vm/firewall.sh rollback  put back what was there before (also what the timer runs)
#
# ROLLBACK by hand, exact: sudo nft flush ruleset; sudo systemctl disable --now nftables;
#                          sudo cp -p /etc/nftables.conf.pre-pmc-* /etc/nftables.conf   (the newest backup)
# Verify from DND-SQL01 between apply and confirm: ssh, https://pbx.pmcne.ph:8443/, https://phone.pmcne.ph/phone,
# and the control that must FAIL: from the guest, a new connection to a LAN host (e.g. DND-SQL01:80).
set -euo pipefail
cd "$(dirname "$0")"
RULES="$(pwd)/nftables-pmc-pbx.nft"
STATE=/var/lib/pmc-pbx/firewall
mkdir -p "$STATE"
case "${1:-}" in
  check)
    nft -c -f "$RULES" && echo "rule file parses: $RULES (nothing changed)"
    ;;
  apply)
    nft -c -f "$RULES"
    stamp=$(date +%Y%m%d-%H%M%S)
    nft list ruleset > "$STATE/ruleset.pre-pmc-$stamp.nft"
    [ -f /etc/nftables.conf ] && cp -p /etc/nftables.conf "/etc/nftables.conf.pre-pmc-$stamp"
    echo "$stamp" > "$STATE/last-backup"
    systemctl stop pmc-fw-rollback.timer 2>/dev/null || true
    systemd-run --quiet --unit pmc-fw-rollback --on-active=300 /bin/bash "$(pwd)/firewall.sh" rollback
    nft -f "$RULES"
    echo "LOADED at $(date +%T). Automatic rollback at $(date -d '+5 min' +%T) unless: sudo bash vm/firewall.sh confirm"
    ;;
  confirm)
    systemctl stop pmc-fw-rollback.timer 2>/dev/null || true
    cp "$RULES" /etc/nftables.conf
    systemctl enable nftables >/dev/null 2>&1
    echo "CONFIRMED: rollback cancelled; /etc/nftables.conf is the PMC rule file and loads at boot"
    ;;
  rollback)
    stamp=$(cat "$STATE/last-backup" 2>/dev/null || true)
    nft flush ruleset
    if [ -n "$stamp" ] && [ -s "$STATE/ruleset.pre-pmc-$stamp.nft" ]; then nft -f "$STATE/ruleset.pre-pmc-$stamp.nft"; fi
    if [ -n "$stamp" ] && [ -f "/etc/nftables.conf.pre-pmc-$stamp" ]; then cp -p "/etc/nftables.conf.pre-pmc-$stamp" /etc/nftables.conf; fi
    echo "ROLLED BACK at $(date +%T) to the ruleset saved at $stamp"
    ;;
  *) echo "usage: $0 check|apply|confirm|rollback"; exit 2 ;;
esac
