#!/bin/sh
# Permit only the SFU's exact bridge address; keep every other private peer denied.
# Re-resolve it after Docker recreates LiveKit, without persisting a stale IP exception.
set -u
child=''
stop() { if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi; exit 0; }
trap stop TERM INT
resolve_sfu() { getent hosts livekit 2>/dev/null | awk '$1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {print $1;exit}'; }
while :; do
  address="$(resolve_sfu)"
  if [ -z "$address" ]; then sleep 2; continue; fi
  turnserver --allowed-peer-ip="$address" "$@" &
  child=$!
  while kill -0 "$child" 2>/dev/null; do
    sleep 2
    next="$(resolve_sfu)"
    if [ -n "$next" ] && [ "$next" != "$address" ]; then
      echo 'LiveKit address changed; refreshing the exact TURN peer exception.'
      kill -TERM "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      child=''
      break
    fi
  done
  if [ -n "$child" ]; then wait "$child"; exit $?; fi
done
