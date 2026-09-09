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

`resolved is not a function` is Emscripten's unresolved-import stub. The symbol
behind it has since been identified: terra imports seven PROJ functions —
`internal_proj_create`, `internal_proj_destroy`,
`internal_proj_context_set_search_paths`, `internal_proj_context_is_network_enabled`,
`internal_proj_context_set_enable_network`, `internal_proj_context_set_url_endpoint`,
`internal_proj_context_get_url_endpoint` — that nothing loaded alongside it
provides. They are exactly the calls `.gdinit()` makes.

The names are renamed because `gdal-config --cflags` in the webR sysroot passes
`-DPROJ_RENAME_SYMBOLS`; the standalone `libproj.a` there exports the plain
names instead. Rebuilding terra 1.9-46 with the same toolchain reproduces the
failure identically, so it is a sysroot packaging mismatch rather than a stale
binary. Full account, including what was tried, in
[TERRA-WASM.md](TERRA-WASM.md).

A related and better-known issue is
[rspatial/terra#1259](https://github.com/rspatial/terra/issues/1259): terra used
to call `proj_context_set_enable_network()` on load, which the browser sandbox
cannot support. That call **is** now guarded by `#ifndef __EMSCRIPTEN__`, in
1.9-27 as well as in current sources, so it is not the remaining problem —
though `internal_proj_context_set_enable_network` still appears among the
unresolved imports, from the other call site.

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

1. **Local R service** (`r-backend/`) — real movecost, native speed, no
   download. This is what the panel uses when it answers on the loopback port.
2. **webR in the page** — now working, with a rebuilt terra served from a
   repository the plugin is pointed at (`MOVECOST_WASM_REPO`); see
   [TERRA-WASM.md](TERRA-WASM.md). About two orders of magnitude slower than the
   R service, and inside GeoLibre Desktop it also needs webR's assets shipped
   with the plugin (next section). The panel says which backend it has.

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
