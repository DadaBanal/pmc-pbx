#!/bin/bash
# deploy-callfeatures-20261014.sh - WS47, run on PMC-PBX01 as pmcadmin. Deploys commits 80e7fdf (call waiting,
# transfer, three-way calls, menu on top) and c5764f8 (radio hold music, voicemail warning) from origin/main.
# Host checkpoint taken first by Dada: pre-callfeatures-80e7fdf, 2026-10-14 08:47:02 (v2 script, VERIFIED).
#
#   bash vm/deploy-callfeatures-20261014.sh            PREVIEW: what would change, nothing changed
#   bash vm/deploy-callfeatures-20261014.sh apply      deploy
#
# Gates: no call up; no unapplied PMO ICT changes waiting (apply would push them live); fast-forward only.
# ROLLBACK, exact (files): cd /opt/pmc-pbx && git checkout <previous sha printed below>; for each
#   /etc/asterisk/{confbridge,musiconhold,voicemail}.conf.pre-callfeatures-<ts> copy it back; rm /usr/local/bin/pmc-moh-radio;
#   then as pmcpbx: node app/admin.js apply; asterisk -rx 'module reload app_confbridge.so' / 'res_musiconhold.so';
#   systemctl restart pmc-pbx. Whole guest: Restore-VMSnapshot -VMName PMC-PBX01 -Name pre-callfeatures-80e7fdf (NUC).
set -euo pipefail
MODE=${1:-preview}
TS=$(date +%Y%m%d-%H%M%S)
REPO=/opt/pmc-pbx
AS="sudo -n /usr/sbin/asterisk -rx"
APP="sudo -n -u pmcpbx env PMC_PBX_CONF=/etc/pmc-pbx PMC_PBX_OUT=/var/lib/pmc-pbx/out /usr/local/bin/node"
calls=$($AS "core show channels count" | grep -oE '^[0-9]+ active call' | cut -d' ' -f1)
echo "calls up now: ${calls:-?}"
[ "${calls:-x}" = "0" ] || { echo "STOP: calls are up; nothing changed"; exit 3; }
pending=$($APP -e "const {loadConfig}=require('$REPO/app/lib/config');const {Store}=require('$REPO/app/lib/store');const V=require('$REPO/app/lib/validate');const c=loadConfig('/etc/pmc-pbx'),s=new Store(c);const m=s.loadManifest(),d=V.normalizeDirectory(s.loadDirectory());console.log(m&&m.directoryVersion===d.version?'none':'WAITING (manifest '+(m&&m.directoryVersion)+', directory '+d.version+')')")
echo "unapplied PMO ICT changes: $pending"
[ "$pending" = "none" ] || { echo "STOP: changes are waiting for PMO ICT to apply; nothing changed"; exit 4; }
cd "$REPO"
before=$(git rev-parse --short HEAD)
git fetch -q origin
echo "code: $before -> $(git rev-parse --short origin/main)"; git log --oneline "$before..origin/main"
for f in confbridge.conf musiconhold.conf voicemail.conf; do
  if git show origin/main:asterisk/conf/$f | cmp -s - /etc/asterisk/$f; then echo "  /etc/asterisk/$f: unchanged"; else echo "  /etc/asterisk/$f: will be replaced (backup .pre-callfeatures-$TS)"; fi
done
[ "$MODE" = "apply" ] || { echo "PREVIEW only. Run again with: apply"; exit 0; }

git merge --ff-only -q origin/main
echo "code now: $(git rev-parse --short HEAD) (rollback: git checkout $before)"
for f in confbridge.conf musiconhold.conf voicemail.conf; do
  sudo -n cp -p /etc/asterisk/$f /etc/asterisk/$f.pre-callfeatures-$TS
  sudo -n install -o asterisk -g asterisk -m 0644 asterisk/conf/$f /etc/asterisk/$f
done
sudo -n install -o root -g root -m 0755 vm/pmc-moh-radio.sh /usr/local/bin/pmc-moh-radio
echo "--- regenerate the dialplan and reload, as the Apply button does"
$APP app/admin.js apply
for m in app_confbridge.so res_musiconhold.so app_voicemail.so; do echo "module reload $m: $($AS "module reload $m" | tr -d '\n')"; done
sudo -n systemctl restart pmc-pbx
sleep 3
echo "pmc-pbx: $(systemctl is-active pmc-pbx)"
