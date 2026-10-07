#!/usr/bin/env bash
# pmc-pbx: build and install Asterisk 22 LTS from source on Debian 12.
# Sequence from the Asterisk README (github.com/asterisk/asterisk, read 7 Oct 2026):
#   contrib/scripts/install_prereq install ; ./configure ; make menuselect ; make install ; make samples
# UNTESTED as of 7 Oct 2026. Phase 2 of docs/pbx-design-20261007.md is its test. Run as root on the VM.
#
# Usage:  sudo ./build-asterisk.sh [version]      default 22.11.0 (asterisk.org, 27 Aug 2026)
# Flags:  SKIP_SIG=1   skip the GPG signature check (print the hash instead). Not for the production build.

set -euo pipefail

VERSION="${1:-22.11.0}"
BASE_URL="https://downloads.asterisk.org/pub/telephony/asterisk"
TARBALL="asterisk-${VERSION}.tar.gz"
WORK="/usr/local/src"
JOBS="$(nproc)"

echo "== pmc-pbx Asterisk build: ${VERSION} on $(. /etc/os-release && echo "$PRETTY_NAME"), $(date -Is)"

if [[ "$(id -u)" -ne 0 ]]; then echo "Run as root (sudo)."; exit 2; fi
if ! grep -q 'VERSION_ID="12"' /etc/os-release; then echo "This script targets Debian 12. Stopping."; exit 2; fi

apt-get update
apt-get install -y build-essential wget gnupg ca-certificates libsrtp2-dev uuid-dev libxml2-dev \
    libncurses5-dev libssl-dev libedit-dev libjansson-dev libsqlite3-dev pkg-config

mkdir -p "$WORK"; cd "$WORK"

# ---- download and verify ----------------------------------------------------------------------
[[ -f "$TARBALL" ]] || wget -O "$TARBALL" "${BASE_URL}/${TARBALL}"
wget -O "${TARBALL}.asc" "${BASE_URL}/${TARBALL}.asc" || true
echo "SHA256 of ${TARBALL}: $(sha256sum "$TARBALL" | cut -d' ' -f1)"

if [[ "${SKIP_SIG:-0}" != "1" ]]; then
    if [[ ! -s "${TARBALL}.asc" ]]; then
        echo "No signature file downloaded. Re-run with SKIP_SIG=1 only for a throwaway build."; exit 3
    fi
    if ! gpg --verify "${TARBALL}.asc" "$TARBALL" 2>/tmp/gpg.err; then
        echo "GPG verify failed or the Asterisk release key is not in root's keyring:"; cat /tmp/gpg.err
        echo "Import the key id shown above from a keyserver after checking it on asterisk.org, then re-run."
        exit 3
    fi
    echo "Signature OK."
fi

# ---- unpack and prerequisites -----------------------------------------------------------------
rm -rf "asterisk-${VERSION}"
tar xzf "$TARBALL"
cd "asterisk-${VERSION}"
contrib/scripts/install_prereq install

# ---- configure and select modules -------------------------------------------------------------
./configure --with-jansson-bundled --with-pjproject-bundled
make menuselect.makeopts
menuselect/menuselect \
    --enable res_srtp --enable res_pjsip --enable res_pjsip_transport_websocket \
    --enable app_voicemail --enable res_ari --enable res_ari_channels --enable res_ari_events \
    --enable CORE-SOUNDS-EN-WAV --enable MOH-OPSOUND-WAV \
    --disable BUILD_NATIVE \
    menuselect.makeopts

# ---- build and install ------------------------------------------------------------------------
make -j"$JOBS"
make install
if [[ ! -e /etc/asterisk/asterisk.conf ]]; then
    make samples
    echo "Sample configs installed (first install)."
fi

# ---- service user and unit --------------------------------------------------------------------
id asterisk >/dev/null 2>&1 || useradd --system --home-dir /var/lib/asterisk --shell /usr/sbin/nologin asterisk
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk 2>/dev/null || true

UNIT_SRC="$(dirname "$(readlink -f "$0")")/asterisk.service"
install -m 0644 "$UNIT_SRC" /etc/systemd/system/asterisk.service
systemctl daemon-reload
systemctl enable asterisk

echo "== Built. Next: copy asterisk/conf/*.conf into /etc/asterisk, run app/gen.js, then: systemctl start asterisk"
echo "== Gate: asterisk -rx 'core show version' must print ${VERSION}"
