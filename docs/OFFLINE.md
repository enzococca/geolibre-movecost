# Running without internet access

On first use the plugin fetches two things over the network:

| What | From | Size |
| --- | --- | --- |
| The webR runtime (R 4.6 as WebAssembly) | `https://webr.r-wasm.org/v0.6.0/` | ~40 MB |
| R packages (`movecost` and dependencies) | `https://repo.r-wasm.org` | ~25 MB |

Both are cached by the webview after the first run, but a genuinely offline or
air-gapped machine needs local copies.

## 1. Mirror the two sources

```bash
# webR runtime
mkdir -p mirror/webr && cd mirror/webr
npm pack webr@0.6.0 && tar xzf webr-0.6.0.tgz --strip-components=1 package/dist
cd -

# R packages for R 4.6 — fetch the .tgz for each name plus its dependencies
mkdir -p mirror/repo/bin/emscripten/contrib/4.6 && cd mirror/repo/bin/emscripten/contrib/4.6
curl -O https://repo.r-wasm.org/bin/emscripten/contrib/4.6/PACKAGES
for p in jsonlite sp raster terra sf gdistance chron movecost; do
  v=$(grep -A1 "^Package: $p$" PACKAGES | tail -1 | cut -d' ' -f2)
  curl -O "https://repo.r-wasm.org/bin/emscripten/contrib/4.6/${p}_${v}.tgz"
done
```

`movecost` also pulls in transitive dependencies (`igraph`, `Rcpp`, `sp`, …).
The simplest way to catch them all is to run the plugin once on a connected
machine with the browser devtools network tab open and mirror every `.tgz` it
requested.

Serve both trees over HTTPS with CORS enabled.

## 2. Point the plugin at the mirror

The runtime reads two `localStorage` overrides, so no rebuild is needed. In
GeoLibre's devtools console:

```js
localStorage.setItem("MOVECOST_WEBR_BASE_URL", "https://mirror.example.org/webr/");
localStorage.setItem("MOVECOST_WASM_REPO", "https://mirror.example.org/repo");
```

Then reload GeoLibre. To bake the values in instead, edit `src/config.ts` and
rebuild.

## Content Security Policy

GeoLibre Desktop restricts where the webview may connect. If the console shows
CSP errors when the engine boots, the mirror's origin has to be allowed by the
host — that is a GeoLibre setting, not something a plugin can change.
