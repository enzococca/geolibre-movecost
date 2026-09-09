#!/usr/bin/env bash
# Put the built plugin site on a `gh-pages` branch, ready for GitHub Pages.
#
#   bash scripts/publish-pages.sh          # builds build/site and commits it to gh-pages
#   git push -u origin main gh-pages       # then, once the GitHub repository exists
#
# GitHub → Settings → Pages → Source: "Deploy from a branch", branch gh-pages,
# folder /. The manifest is then at
#   https://<user>.github.io/<repo>/plugin.json
# which is what goes into GeoLibre "URL dei manifest" — the install route that
# works on iOS and Android — and into plugin-registry-entry.json.
#
# The site lives on an orphan branch so the 10 MB terra WebAssembly binary and
# every rebuild of it stay out of main's history. A git worktree keeps the
# checkout of main untouched while the branch is updated.
set -euo pipefail
cd "$(dirname "$0")/.."

for required in dist/index.js dist/style.css geolibre-plugin/plugin.json; do
  [ -f "$required" ] || { echo "Missing $required — run: npm run build" >&2; exit 1; }
done

# Not build/site: that directory may be live under scripts/serve-plugin.sh, and
# rebuilding it under a running server leaves the server pointing at a deleted
# directory.
SITE="$PWD/build/pages-site"
rm -rf "$SITE"
mkdir -p "$SITE/dist"
cp geolibre-plugin/plugin.json "$SITE/plugin.json"
cp dist/index.js dist/style.css "$SITE/dist/"
[ -d build/wasm-repo ] && cp -R build/wasm-repo "$SITE/wasm-repo"
touch "$SITE/.nojekyll"   # Pages must not run Jekyll over the repository tree

# A second copy of the manifest under a versioned name. GeoLibre pins the
# bundle hash per manifest URL and, on the mobile builds, a plugin held back
# by a changed hash can be neither reloaded nor un-pinned by removing the URL
# (the pin is only dropped for a plugin that was actually loaded). A URL nobody
# has used before carries no pin, so each release gets one of its own;
# `plugin.json` stays the stable address for the registry and the desktop.
VERSION=$(python3 -c "import json;print(json.load(open('geolibre-plugin/plugin.json'))['version'])")
cp geolibre-plugin/plugin.json "$SITE/plugin-$VERSION.json"

cat > "$SITE/index.html" <<HTML
<!doctype html><meta charset="utf-8"><title>movecost for GeoLibre</title>
<p>Plugin manifest: <a href="plugin.json">plugin.json</a> — paste that URL into
GeoLibre → Manage Plugins → Settings → Manifest URLs.</p>
<p>On iPad or Android, where an updated plugin cannot be re-accepted, use the
versioned manifest instead — remove the old URL and add
<a href="plugin-$VERSION.json">plugin-$VERSION.json</a>.</p>
HTML

WORK="$PWD/build/gh-pages-worktree"
rm -rf "$WORK"
git worktree prune
if git show-ref --verify --quiet refs/heads/gh-pages; then
  git worktree add "$WORK" gh-pages
else
  git worktree add --detach "$WORK"
  git -C "$WORK" checkout --orphan gh-pages
  git -C "$WORK" rm -rfq . 2>/dev/null || true
fi

# Replace the branch contents wholesale with the freshly built site.
find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$SITE"/. "$WORK"/
git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then
  echo "gh-pages already up to date."
else
  version="$VERSION"
  git -C "$WORK" commit -q -m "Publish movecost plugin $version" \
    -m "Built from $(git rev-parse --short HEAD) on main."
  echo "Committed the site to gh-pages."
fi
git worktree remove --force "$WORK"

echo
echo "Next: git push -u origin main gh-pages, then enable Pages on the gh-pages branch."
