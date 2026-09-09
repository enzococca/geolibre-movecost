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

## If the image will not pull

`docker pull ghcr.io/r-wasm/webr:main` fetches a multi-gigabyte image, and a
dropped connection puts the pull into an endless `Retrying in N seconds` loop
rather than failing outright. If that happens, stop it and pull the image on its
own first, so the retry has nothing else waiting on it:

```bash
docker pull ghcr.io/r-wasm/webr:main     # resumes from what it already has
bash scripts/build-terra-wasm.sh         # then run the build
```

Layers already downloaded are kept, so re-running the pull makes progress each
time rather than starting over.

## What the rebuild established

It was run. terra 1.9-46 builds cleanly for WebAssembly against webR 0.6.0's
toolchain, installs from this repository, and **still fails to load with exactly
the same error** as the upstream 1.9-27 binary. So the problem was never a stale
or mismatched build.

`scripts/wasm-missing-symbols.py` names the cause. Both binaries import seven
PROJ functions that nothing provides:

```
internal_proj_create
internal_proj_destroy
internal_proj_context_set_search_paths
internal_proj_context_is_network_enabled
internal_proj_context_set_enable_network
internal_proj_context_set_url_endpoint
internal_proj_context_get_url_endpoint
```

R.wasm exports no PROJ symbols at all, and these are precisely the calls terra
makes from `.onLoad` → `.gdinit()` → `.gdalinit()`. The first one reached throws
the Emscripten stub error.

Why they are renamed: `gdal-config --cflags` in the webR sysroot passes
`-DPROJ_RENAME_SYMBOLS`, which makes `proj.h` rewrite every PROJ call to
`internal_proj_*`. GDAL vendors a renamed PROJ inside `libgdal.a`, but those
symbols are hidden and not re-exported to a side module — while the standalone
`/opt/webr/wasm/lib/libproj.a` exports the **plain** names (`proj_create`, …),
verified with `emnm`. The header says renamed; the library that could satisfy
them says plain.

## What was tried, and what to try next

`PROJ_WORKAROUND=1 bash scripts/build-terra-wasm.sh` cancels the define with
`-UPROJ_RENAME_SYMBOLS`, injected into rwasm's own `webr-vars.mk` (rwasm sets
`R_MAKEVARS_USER` to that file, so `~/.R/Makevars` is ignored — that detail
costs an hour if you miss it). terra then compiles, and fails at link:

```
wasm-ld: error: duplicate symbol: geod_position
```

because the same define also renames terra's **bundled GeographicLib** routines,
which without it collide with the copies inside PROJ/GDAL. The define does two
jobs and only one of them is wrong here.

The surgical variant, not yet tried: keep `-DPROJ_RENAME_SYMBOLS` and map only
the seven PROJ entry points back to their plain names, so the geodesic renaming
is untouched:

```make
CPPFLAGS += -Dinternal_proj_create=proj_create \
            -Dinternal_proj_destroy=proj_destroy \
            -Dinternal_proj_context_set_search_paths=proj_context_set_search_paths \
            -Dinternal_proj_context_is_network_enabled=proj_context_is_network_enabled \
            -Dinternal_proj_context_set_enable_network=proj_context_set_enable_network \
            -Dinternal_proj_context_set_url_endpoint=proj_context_set_url_endpoint \
            -Dinternal_proj_context_get_url_endpoint=proj_context_get_url_endpoint
```

(The mutual `proj_create` → `internal_proj_create` → `proj_create` expansion
terminates: the preprocessor will not re-expand a macro inside its own
expansion.) The link line then also needs `-lproj` if `gdal-config --libs` does
not already supply it.

## Reporting it upstream

This is a webR sysroot packaging problem rather than a terra one: the PROJ build
flags and the PROJ library disagree. It is worth an issue on
[r-wasm/webr](https://github.com/r-wasm/webr/issues) with the symbol list above.
The plugin keeps working through the local R service in the meantime.
