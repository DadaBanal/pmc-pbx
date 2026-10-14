#!/bin/bash
# install-coturn.sh - WS47 call relay on PMC-PBX01 (Dada, 14 Oct 2026: "do the call relay now"). Run as pmcadmin
# from /opt/pmc-pbx:
#
#   bash vm/coturn/install-coturn.sh            PREVIEW: verify the sources and the config; change nothing
#   bash vm/coturn/install-coturn.sh apply      build, install, give the relay its address, user, firewall, start it
#
# The source comes twice, from two places, and both must match what was measured on 14 Oct 2026:
#   ~/coturn-src/coturn-4.18.0.tar.gz        github.com/coturn/coturn tag 4.18.0 (released 8 Sep 2026), 828,514 bytes
#   ~/coturn-src/coturn_4.18.0.orig.tar.xz   deb.debian.org, Debian's copy for forky/sid, 578,044 bytes (its .dsc)
# and the two must hold the same src/ tree. Debian 12 and 13 ship 4.6.1 with 8 open security issues (Debian security
# tracker, 14 Oct 2026), so the relay is built from 4.18.0. Build needs libevent-dev from Debian (5 packages).
#
# This does NOT turn the relay on for phones: config.json "relay" does that, after DNS (relay.pmcne.ph) and the UDM
# forward of 103.144.157.236 exist. Until then nothing points at it.
#
# ROLLBACK, exact: sudo systemctl disable --now coturn; sudo rm /etc/systemd/system/coturn.service /etc/coturn -r;
#   sudo rm -r /opt/coturn; sudo ip addr del 10.2.0.12/22 dev eth0; restore /etc/network/interfaces.pre-relay-<ts>;
#   firewall: cd /opt/pmc-pbx/vm && sudo bash firewall.sh rollback (before confirm) or load the previous rule file;
#   sudo deluser turnserver. Whole guest: Restore-VMSnapshot post-callfeatures-7fa7606 (NUC, Dada).
set -euo pipefail
MODE=${1:-preview}
REPO=/opt/pmc-pbx
SRC=$HOME/coturn-src
GH=$SRC/coturn-4.18.0.tar.gz
DEB=$SRC/coturn_4.18.0.orig.tar.xz
GH_SHA=28d55294ac596fbd129b293a85e7bb1c5dc4bd15b7fb55c500f355149e5f4e28
DEB_SHA=4e1c4cfa758f7c862852dadbdd492c3c1293c16b25bbc81f6200aea7cc20456b
fail() { echo "STOP: $*"; exit 1; }

echo "--- 1. the two copies of the source"
[ -f "$GH" ] && [ -f "$DEB" ] || fail "download both copies into $SRC first (see the header)"
echo "$GH_SHA  $GH" | sha256sum -c --quiet || fail "GitHub tarball checksum differs from the one measured 14 Oct"
echo "$DEB_SHA  $DEB" | sha256sum -c --quiet || fail "Debian copy checksum differs from its .dsc"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir "$W/gh" "$W/deb"
tar -xzf "$GH" -C "$W/gh" --strip-components=1
tar -xJf "$DEB" -C "$W/deb" --strip-components=1
diff -r "$W/gh/src" "$W/deb/src" >/dev/null || fail "GitHub and Debian copies hold different src/ trees"
echo "  both checksums match; src/ identical in both ($(find "$W/gh/src" -type f | wc -l) files)"

echo "--- 2. every option in our config exists in coturn 4.18.0's own example"
EX="$W/gh/examples/etc/turnserver.conf"
missing=0
for k in $(grep -vE '^\s*(#|$)' "$REPO/vm/coturn/turnserver.conf.in" | sed -E 's/[= ].*//' | sort -u); do
  grep -qE "^#?\s*${k}([= ]|$)" "$EX" || { echo "  NOT IN THE EXAMPLE: $k"; missing=1; }
done
[ $missing = 0 ] || fail "an option above is not one coturn 4.18.0 documents"
echo "  all options documented"
grep -qE 'TURN_NO_SQLITE' "$W/gh/configure" || fail "configure no longer knows TURN_NO_SQLITE"

calls=$(sudo -n /usr/sbin/asterisk -rx "core show channels count" | grep -oE '^[0-9]+ active call' | cut -d' ' -f1)
echo "--- 3. calls up now: $calls (the relay install does not touch calls; the firewall reload does not drop them)"
[ "$MODE" = "apply" ] || { echo "PREVIEW only. Run again with: apply"; exit 0; }

TS=$(date +%Y%m%d-%H%M%S)
echo "--- 4. build ($(nproc) cpu), no database backends: the relay keeps no users, only the shared secret"
dpkg-query -W -f='${Status}' libevent-dev 2>/dev/null | grep -q 'install ok installed' || fail "libevent-dev is not installed"
cd "$W/gh"
TURN_NO_SQLITE=1 TURN_NO_MYSQL=1 TURN_NO_PQ=1 TURN_NO_MONGO=1 TURN_NO_HIREDIS=1 TURN_NO_PROMETHEUS=1 \
  ./configure --prefix=/opt/coturn > "$W/configure.log" 2>&1 || { tail -20 "$W/configure.log"; fail "configure"; }
make -j"$(nproc)" > "$W/make.log" 2>&1 || { tail -30 "$W/make.log"; fail "make"; }
sudo -n make install > "$W/install.log" 2>&1 || { tail -20 "$W/install.log"; fail "make install"; }
/opt/coturn/bin/turnserver --version 2>/dev/null | head -1 || true

echo "--- 5. its user, its address, its config"
getent passwd turnserver >/dev/null || sudo -n adduser --system --group --no-create-home --home /nonexistent --shell /usr/sbin/nologin turnserver
ip -4 addr show dev eth0 | grep -q ' 10.2.0.12/' || sudo -n ip addr add 10.2.0.12/22 dev eth0
if ! grep -q '10.2.0.12' /etc/network/interfaces; then
  sudo -n cp -p /etc/network/interfaces /etc/network/interfaces.pre-relay-$TS
  sudo -n sed -i 's|^    down ip addr del 10.2.0.11/22 dev eth0$|&\n    up ip addr add 10.2.0.12/22 dev eth0\n    down ip addr del 10.2.0.12/22 dev eth0|' /etc/network/interfaces
  grep -q 'up ip addr add 10.2.0.12/22' /etc/network/interfaces || fail "could not add 10.2.0.12 to /etc/network/interfaces"
fi
SECRET=$(sudo -n node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/etc/pmc-pbx/secrets/secrets.json','utf8')).turn||'')")
[ ${#SECRET} = 64 ] || fail "secrets.json has no relay secret: add \"relay\" to config.json and Apply first"
sudo -n install -d -o root -g turnserver -m 0750 /etc/coturn
sed "s|@SECRET@|$SECRET|" "$REPO/vm/coturn/turnserver.conf.in" | sudo -n tee /etc/coturn/turnserver.conf >/dev/null
sudo -n chown root:turnserver /etc/coturn/turnserver.conf; sudo -n chmod 0640 /etc/coturn/turnserver.conf
sudo -n install -o root -g root -m 0644 "$REPO/vm/coturn/coturn.service" /etc/systemd/system/coturn.service

echo "--- 6. firewall (auto-rollback in 5 minutes unless confirmed)"
cd "$REPO/vm" && sudo -n bash firewall.sh apply

echo "--- 7. start"
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now coturn
sleep 2
systemctl is-active coturn
sudo -n ss -lntup | grep -E '10\.2\.0\.12:(443|3478)' || fail "the relay is not listening on 10.2.0.12"
echo "Verify, then: cd $REPO/vm && sudo bash firewall.sh confirm"
