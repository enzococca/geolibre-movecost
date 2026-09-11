#!/usr/bin/env bash
# Refresh the movecost entry in a checkout of the geolibre-plugins fork.
#
#   bash scripts/update-registry.sh [~/geolibre-plugins]
#
# Copies the built bundle in, rewrites the plugin's own manifest for the layout
# the registry uses (the bundle sits beside it, not under dist/), updates the
# registry entry, and runs the repository's own validate and minify checks.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$PWD"
DST="${1:-$HOME/geolibre-plugins}"

cp "$SRC/dist/index.js"  "$DST/plugins/movecost/index.js"
cp "$SRC/dist/style.css" "$DST/plugins/movecost/style.css"

python3 - "$SRC/geolibre-plugin/plugin.json" "$SRC/plugin-registry-entry.json" \
         "$DST/plugins/movecost/plugin.json" "$DST/plugin-registry.json" <<'INNER'
import json, re, sys

manifest_src, entry_src, manifest_dst, registry = sys.argv[1:5]
entry = json.load(open(entry_src))

# The registry serves the bundle next to the manifest, not under dist/. The
# author and homepage live here rather than in the plugin's own manifest,
# which the zip verifier rejects them in.
manifest = json.load(open(manifest_src))
manifest["entry"] = "index.js"
manifest["style"] = "style.css"
for key in ("author", "homepage"):
    if key in entry:
        manifest[key] = entry[key]
with open(manifest_dst, "w") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write("\n")

# plugin-registry.json is edited as text, one field at a time, rather than
# reparsed and dumped. json.dump would reformat the whole file — it expands
# every "categories" array onto its own lines — and the maintainer has to undo
# it with prettier, which is exactly what happened once. Nobody wants a
# forty-line diff to change a version string.
text = open(registry).read()
start = text.index('"id": "movecost"')
# The entry ends at its own closing brace: match the indent rather than the
# comma after it, which the last entry in the array does not have.
closing = re.search(r"\n    \}", text[start:])
if not closing:
    raise SystemExit("cannot find the end of the movecost entry")
end = start + closing.start()
block = text[start:end]

for key, value in entry.items():
    if key in ("id", "categories"):
        continue
    pattern = re.compile(rf'("{re.escape(key)}":\s*)"(?:[^"\\]|\\.)*"')
    if pattern.search(block):
        block = pattern.sub(lambda m: m.group(1) + json.dumps(value, ensure_ascii=False), block, count=1)
    else:
        raise SystemExit(f'the registry entry has no "{key}" to update; add it there by hand once')

# Categories are a list, and rewriting one in place would mean guessing the
# formatting. They change about never, so say so instead of getting it wrong.
listed = json.loads("[" + re.search(r'"categories":\s*\[(.*?)\]', block, re.S).group(1) + "]")
if listed != entry.get("categories", listed):
    raise SystemExit(f"categories differ: registry has {listed}, entry has {entry['categories']} — edit by hand")

with open(registry, "w") as f:
    f.write(text[:start] + block + text[end:])
print("registry entry now", entry["version"])
INNER

cd "$DST"
npm run --silent minify
npm run --silent validate
npm run --silent minify:check
