#!/bin/bash
# pmc-moh-radio - WS47 hold music from internet radio, installed as /usr/local/bin/pmc-moh-radio.
#
# Dada, 14 Oct 2026: "the music on hold can we use a 00's radio station for this?" and "go for the raido or any radio
# that plays english 2000's music or filipino music". The licence question (FILSCAP: Supreme Court, FILSCAP v. Anrey,
# G.R. 233918, 9 Aug 2022) was put to him; the decision to go is his.
#
# Asterisk runs this (musiconhold.conf [default], mode=custom, format=slin16) and reads 16 kHz, 16-bit, mono PCM from
# its stdout. It never exits on its own: it plays the first station that answers, falls back to the next if one fails,
# and after a station has played for a minute it goes back to the first one, so the main station is preferred.
# If every station fails it waits 20 s and tries again; callers on hold hear silence meanwhile.
# Asterisk reads only while someone is on hold (res_musiconhold.c, no directory set), so between holds the pipe fills,
# the download stalls and almost no internet is used. curl gives up on a stalled stream after 20 s; the next hold starts
# with a few seconds of buffered audio, then a fresh connection.
#
# Stations, both checked from PMC-PBX01 as user asterisk on 14 Oct 2026 (HTTP 200 / redirect, audio/mpeg, MP3 frames):
STATIONS=(
  "https://0n-2000s.radionetz.de/0n-2000s.mp3"            # "0 N - 2000s on Radio": English 2000s hits, 128 kbps
  "http://ais-edge50-live365-dal02.cdnstream.com/a63316"  # "MYX P-Pop Radio": Filipino pop, 128 kbps
)
# ROLLBACK: restore /etc/asterisk/musiconhold.conf from its .pre-radio-* copy, then
#   asterisk -rx 'module reload res_musiconhold.so'     (the bundled music files come back; this script stops)
while :; do
  for url in "${STATIONS[@]}"; do
    start=$(date +%s)
    /usr/bin/curl -sfL --connect-timeout 10 --speed-limit 1000 --speed-time 20 -A 'PMC-PBX-hold-music/1' "$url" 2>/dev/null \
      | /usr/bin/mpg123 -q --no-control -f 16384 --mono -r 16000 -e s16 -s - 2>/dev/null
    # -f 16384: half the full scale, so a loud radio master is not loud in someone's ear
    if [ $(( $(date +%s) - start )) -ge 60 ]; then continue 2; fi   # it played: start again from the first station
  done
  sleep 20
done
