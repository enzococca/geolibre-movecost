# Building a loadable `terra` for WebAssembly

The in-browser backend is one package away from working: everything installs and
`sf` loads, but `library(terra)` hits an unresolved symbol in the prebuilt
binary from `repo.r-wasm.org` (see [WEBR-FINDINGS.md](WEBR-FINDINGS.md)).
Rebuilding terra against the same webR toolchain resolves the symbol mismatch,
and the plugin can then be pointed at that repository with no code change.

## What you need

- Docker or Podman (the toolchain image is Linux/x86-64; on Apple Silicon it
  runs under emulation, slowly but successfully)
- ~15 GB of disk for the image, the wasm sysroot and the build tree
- Somewhere to serve the result over HTTPS with CORS

## Build

```bash
bash scripts/build-terra-wasm.sh
```

The script drives [`rwasm`](https://github.com/r-wasm/rwasm) inside
`ghcr.io/r-wasm/webr:main`, whose R and Emscripten versions match the webR
release the plugin loads. Change `WEBR_VERSION` at the top of the script if you
move the plugin to a different webR release — the whole point is that the
package and the runtime come from the same toolchain.

Output is a CRAN-shaped repository tree:

```
build/wasm-repo/
  bin/emscripten/contrib/4.6/
    PACKAGES
    PACKAGES.gz
    terra_1.9-50.tgz
    ...
```

## Serve and use it

Serve `build/wasm-repo/` over HTTPS with `Access-Control-Allow-Origin: *`, then
tell the plugin to install from there. In GeoLibre's devtools console:

```js
localStorage.setItem("MOVECOST_WASM_REPO", "https://your-host/wasm-repo");
```

Reload GeoLibre and open the panel. To bake it in instead, edit
`WASM_CRAN_REPO` in `src/config.ts` and rebuild.

Because webR falls back to `repo.r-wasm.org` for anything your repository does
not carry, you can host **only** the packages you rebuilt. The safest set is
terra plus everything that links against it:

```
terra raster gdistance movecost
```

## Checking the result before shipping it

```bash
python3 scripts/wasm-missing-symbols.py R.wasm build/terra/libs/terra.so
```

Zero unresolved function imports means the stub that throws
"resolved is not a function" is gone. Then load the demo page
(`npm run serve:demo`), clear the local R service override, and confirm the
panel reports `In-browser R (movecost …)` and completes an analysis.

## If the rebuild does not fix it

The remaining possibility is that terra needs a GDAL or PROJ symbol webR's R
build genuinely does not provide, in which case the fix belongs upstream: open
an issue on [r-wasm/webr](https://github.com/r-wasm/webr/issues) with the symbol
name from `wasm-missing-symbols.py`. The plugin keeps working through the local
R service in the meantime.
