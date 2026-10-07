#!/usr/bin/env bash
# pmc-pbx: build and install Asterisk 22 LTS from source on Debian 12.
# Sequence from the Asterisk README (github.com/asterisk/asterisk, read 7 Oct 2026):
#   contrib/scripts/install_prereq install ; ./configure ; make menuselect ; make install ; make samples
# First proven in GitHub Actions (debian:12 container) on 7 Oct 2026; the VM build in phase 2 is the second test.
# Run as root on the VM.
#
# Usage:  sudo ./build-asterisk.sh [version]      default 22.11.0 (asterisk.org, 27 Aug 2026)
# Flags:  SKIP_SIG=1   skip the GPG signature check (print the hash instead). CI and throwaway builds only.

set -euo pipefail

VERSION="${1:-22.11.0}"
BASE_URL="https://downloads.asterisk.org/pub/telephony/asterisk"
TARBALL="asterisk-${VERSION}.tar.gz"
WORK="/usr/local/src"
JOBS="$(nproc)"
export DEBIAN_FRONTEND=noninteractive

echo "== pmc-pbx Asterisk build: ${VERSION} on $(. /etc/os-release && echo "$PRETTY_NAME"), $(date -Is), ${JOBS} job(s)"

if [[ "$(id -u)" -ne 0 ]]; then echo "Run as root (sudo)."; exit 2; fi
if ! grep -q 'VERSION_ID="12"' /etc/os-release; then echo "This script targets Debian 12. Stopping."; exit 2; fi

apt-get update
apt-get install -y build-essential wget gnupg ca-certificates libsrtp2-dev uuid-dev libxml2-dev \
    libncurses-dev libssl-dev libedit-dev libjansson-dev libsqlite3-dev pkg-config

mkdir -p "$WORK"; cd "$WORK"

# ---- download and verify ----------------------------------------------------------------------
[[ -f "$TARBALL" ]] || wget -q -O "$TARBALL" "${BASE_URL}/${TARBALL}"
wget -q -O "${TARBALL}.asc" "${BASE_URL}/${TARBALL}.asc" || true
ACTUAL_SHA256="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
echo "SHA256 of ${TARBALL}: ${ACTUAL_SHA256}"

# Hash pinned from the CI download of 7 Oct 2026 (run 37579821043). It makes later builds reproducible
# against that artifact; it is NOT an authenticity proof - the .asc signature below is.
case "$VERSION" in
    22.11.0) PINNED_SHA256="3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94" ;;
    *)       PINNED_SHA256="" ;;
esac
if [[ -n "$PINNED_SHA256" ]]; then
    if [[ "$ACTUAL_SHA256" != "$PINNED_SHA256" ]]; then
        echo "STOP: ${TARBALL} does not match the pinned SHA256 for ${VERSION}. Not building it."; exit 3
    fi
    echo "Matches the pinned SHA256 for ${VERSION}."
else
    echo "No pinned SHA256 for ${VERSION}; signature check is the only verification."
fi

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
else
    echo "SKIP_SIG=1: signature not checked (CI or throwaway build)."
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
    --enable res_srtp --enable res_pjsip \
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
mkdir -p /var/run/asterisk
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk 2>/dev/null || true

UNIT_SRC="$(dirname "$(readlink -f "$0")")/asterisk.service"
if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
    install -m 0644 "$UNIT_SRC" /etc/systemd/system/asterisk.service
    systemctl daemon-reload
    systemctl enable asterisk
    echo "systemd unit installed and enabled."
else
    echo "No systemd here (container?). Unit not installed; start with: /usr/sbin/asterisk -U asterisk -G asterisk"
fi

echo "== Built. Next: copy asterisk/conf/*.conf into /etc/asterisk, run app/gen.js, then start asterisk"
echo "== Gate: /usr/sbin/asterisk -V must print Asterisk ${VERSION}"
