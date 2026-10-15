#!/usr/bin/env bash
# Trusts the local CA of the Caddy HTTPS proxy (LAN mode) on this computer, so the browser
# stops warning about https://<LAN-IP>:8443. Run after `make up` (Caddy creates the CA on start).
set -euo pipefail
cd "$(dirname "$0")/.."
OS="$(uname -s)"
CERT=./concord-local-ca.crt

docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$CERT" >/dev/null
echo "Root certificate saved to $CERT"

if [ "$OS" = "Darwin" ]; then
  echo "Adding to the macOS System keychain (asks for your password)…"
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CERT"
  echo "Done. Restart the browser. (Firefox: Settings → Privacy → Certificates → Import, or set security.enterprise_roots.enabled.)"
else
  if [ -d /usr/local/share/ca-certificates ]; then
    sudo cp "$CERT" /usr/local/share/ca-certificates/concord-local-ca.crt
    sudo update-ca-certificates
  elif [ -d /etc/pki/ca-trust/source/anchors ]; then
    sudo cp "$CERT" /etc/pki/ca-trust/source/anchors/concord-local-ca.crt
    sudo update-ca-trust
  fi
  # Chrome/Chromium on Linux use their own NSS database.
  if command -v certutil >/dev/null 2>&1; then
    mkdir -p "$HOME/.pki/nssdb"
    certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n "Concord local CA" -i "$CERT"
    echo "Added to Chrome/Chromium (NSS)."
  else
    echo "For Chrome/Chromium install certutil (Debian/Ubuntu: sudo apt install libnss3-tools) and re-run."
  fi
  echo "Done. Restart the browser."
fi
echo "Phones/tablets: open the file $CERT on the device and install it as a trusted certificate,"
echo "See docs/LAN.md for per-device trust instructions; a browser warning bypass is insufficient for media testing."
