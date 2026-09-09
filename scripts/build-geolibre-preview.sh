#!/usr/bin/env bash
# Build a local GeoLibre web app with this plugin baked in, the same way the
# registry's "Plugin preview" workflow does.
#
#   bash scripts/build-geolibre-preview.sh [geolibre-checkout]
#
# GeoLibre scans apps/geolibre-desktop/public/plugins/ at build start and loads
# whatever it finds, with no registry entry and no manifest URL — so testing a
# built bundle against a real host is a copy plus a build. The upstream preview
# on opengeos.org depends on a maintainer approving the workflow run and on a
# Pages build that has failed repeatedly, which is why this exists locally.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$PWD"
APP="${1:-$HOME/geolibre-app}"

if [ ! -d "$APP/.git" ]; then
  echo "== cloning opengeos/GeoLibre into $APP"
  git clone --depth 1 https://github.com/opengeos/GeoLibre "$APP"
else
  echo "== reusing $APP"
  git -C "$APP" fetch --depth 1 origin && git -C "$APP" reset --hard origin/HEAD
fi

dest="$APP/apps/geolibre-desktop/public/plugins/movecost"
mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
mkdir -p "$dest"
cp "$SRC/dist/index.js" "$SRC/dist/style.css" "$dest/"
python3 - "$SRC/geolibre-plugin/plugin.json" "$dest/plugin.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
m["entry"] = "index.js"
m["style"] = "style.css"
json.dump(m, open(sys.argv[2], "w"), indent=2, ensure_ascii=False)
PY
echo "== baked in: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$dest/plugin.json")"

cd "$APP"
[ -d node_modules ] || npm ci
GEOLIBRE_APP_BASE=./ npm run build -w geolibre-desktop
find apps/geolibre-desktop/dist -name .gitignore -delete
test -f apps/geolibre-desktop/dist/plugins/movecost/plugin.json \
  || { echo "the plugin did not reach dist/"; exit 1; }
echo "== built: $APP/apps/geolibre-desktop/dist"
