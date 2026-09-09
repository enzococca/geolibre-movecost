# webR feasibility: why the in-browser backend is currently blocked

Tested 2026-09-09 against webR 0.6.0 (R 4.6.0) and 0.5.9 (R 4.5.1), in a
cross-origin-isolated page (`SharedArrayBuffer` available, so webR ran on its
full-capability channel), with packages from `repo.r-wasm.org`.

## What works

| Step | Result |
| --- | --- |
| Boot webR 0.6.0 in the browser | ✅ R 4.6.0 running |
| Install `movecost` 2.2 and its whole dependency stack | ✅ all installed |
| `library(sf)`, `library(sp)`, `library(chron)` | ✅ load |
| The engine under a native `Rscript` | ✅ 8/8 analyses pass |

## What does not

```r
library(terra)
#> Error: resolved is not a function      (Emscripten stub, thrown from R.wasm)
```

Reproducible on R 4.5 and R 4.6 builds, in a clean session, with and without
cross-origin isolation. The failure happens inside terra's `.onLoad`, which
calls `.gdinit()` → `.gdalinit()` to initialise GDAL and PROJ.

`resolved is not a function` is Emscripten's unresolved-import stub: terra's
`terra.so` imports a symbol that webR's `R.wasm` does not export. It is a
build-compatibility problem between the two, not a configuration problem on our
side — `sf`, which links the same GDAL/PROJ/GEOS stack, loads fine.

The related and better-known issue is
[rspatial/terra#1259](https://github.com/rspatial/terra/issues/1259): terra used
to call `proj_context_set_enable_network()` on load, which the browser sandbox
cannot support. That call **is** now guarded by `#ifndef __EMSCRIPTEN__`, in
1.9-27 as well as in current sources, so the guard is not the remaining problem —
something else in the GDAL init path is.

The failure cascades over the whole raster stack:

- `raster` 3.6 has `terra` in **Imports** → `library(raster)` fails.
- `gdistance` depends on `raster` → fails.
- `movecost` **2.x** imports both `raster` and `terra` → fails.
- `movecost` **3.x** imports `terra` → would fail too.

R loads a package's `Imports` namespaces when the package loads, so there is no
subset of movecost that avoids terra.

## A second obstacle, inside GeoLibre Desktop

Even with a loadable terra, the in-browser backend needs one more thing. The
desktop app's Content-Security-Policy ends with:

```
worker-src blob: 'self'
```

webR starts its R worker from `baseUrl + "webr-worker.js"`, so loading it from
`https://webr.r-wasm.org/` is refused inside the app — the CDN is not `'self'`.
The fix is to ship webR's `dist/` as plugin assets and resolve it through the
host, which makes it same-origin:

```ts
new MovecostEngine(app.resolvePluginAssetUrl?.("movecost", "webr/") ?? undefined)
```

The plugin already does this (`MovecostPanel.webrBaseUrl()`), falling back to the
CDN when no bundled copy is installed. To install one, copy webR's `dist/` into
the plugin folder as `webr/` — about 40 MB — next to `plugin.json`.

The same CSP is good news for the other backend: `connect-src` explicitly lists
`http://127.0.0.1:*` and `http://localhost:*`, so the plugin may talk to the
local R service without any host change.

## Where that leaves the plugin

The plugin ships **two backends** and prefers whichever works:

1. **Local R service** (`r-backend/`) — the working path today. Real movecost,
   native speed, no download. This is what the panel uses when it answers on the
   loopback port.
2. **webR in the page** — kept, because everything except terra already works
   and the moment a loadable terra wasm build exists it becomes the zero-install
   path. Until then the panel says so rather than failing silently.

## Reproducing the diagnosis

`scripts/wasm-missing-symbols.py` diffs a package's `.so` imports against
`R.wasm`'s exports, to name the symbol behind the stub:

```bash
curl -O https://repo.r-wasm.org/bin/emscripten/contrib/4.6/terra_1.9-27.tgz
tar xzf terra_1.9-27.tgz
curl -sL https://webr.r-wasm.org/v0.6.0/R.wasm | gunzip > R.wasm   # it is gzipped
python3 scripts/wasm-missing-symbols.py R.wasm terra/libs/terra.so
```

## Fixing it

Build terra for WebAssembly against the same webR toolchain, with
[rwasm](https://github.com/r-wasm/rwasm), and serve it from a repository the
plugin points at via `MOVECOST_WASM_REPO`. See
[TERRA-WASM.md](TERRA-WASM.md).
