#!/usr/bin/env bash
# Serve the built plugin (and the rebuilt terra repository, when present) over
# HTTP with CORS, so a GeoLibre on another device can install it by manifest
# URL — the only install route that works on iOS and Android, where "install
# from .zip" needs a filesystem path the app sandbox does not give it.
#
#   bash scripts/serve-plugin.sh            # http://<this-mac>:8790/plugin.json
#   bash scripts/serve-plugin.sh --tunnel   # also opens a public HTTPS URL via
#                                           # cloudflared (quick tunnel, no account)
#
# GeoLibre requires HTTPS for manifest URLs except on localhost, so a device on
# the same Wi-Fi still needs the tunnel (or any HTTPS host) — plain http://<ip>
# is refused. For something permanent, copy build/site/ to GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8790}"
SITE="build/site"

for required in dist/index.js dist/style.css geolibre-plugin/plugin.json; do
  [ -f "$required" ] || { echo "Missing $required — run: npm run build" >&2; exit 1; }
done

rm -rf "$SITE"
mkdir -p "$SITE/dist"
cp geolibre-plugin/plugin.json "$SITE/plugin.json"
cp dist/index.js dist/style.css "$SITE/dist/"
if [ -d build/wasm-repo ]; then
  cp -R build/wasm-repo "$SITE/wasm-repo"
fi

cat > "$SITE/.server.py" <<'PY'
import http.server, os, sys
class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def do_OPTIONS(self):
        self.send_response(204); self.end_headers()
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), Handler).serve_forever()
PY

echo "Serving $SITE on http://0.0.0.0:$PORT  (manifest: /plugin.json)"
python3 "$SITE/.server.py" "$PORT" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

if [ "${1:-}" = "--tunnel" ]; then
  command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }
  echo "Opening a quick tunnel — the https URL below is the one to paste into GeoLibre:"
  cloudflared tunnel --url "http://127.0.0.1:$PORT" 2>&1 | grep --line-buffered -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | sed 's#$#/plugin.json#' &
  wait $!
else
  wait $SERVER
fi
