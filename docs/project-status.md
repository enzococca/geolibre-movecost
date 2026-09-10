# GeoLibre movecost plugin — status

Project lives at `~/geolibre-movecost` on the Mac (mac-home) and on GitHub at
**https://github.com/enzococca/geolibre-movecost** (main + orphan `gh-pages`).
Version 0.2.0. GeoLibre is 2.9.0 on both the Mac and the iPad.

**Published manifest (permanent):**
`https://enzococca.github.io/geolibre-movecost/plugin.json`
— serves plugin.json, dist/, and `wasm-repo/` (the rebuilt terra and
movecost 3.0.0 for WebAssembly) with CORS.
Republish with `bash scripts/publish-pages.sh && git push origin gh-pages`;
if the Pages build does not pick it up, `gh api -X POST repos/enzococca/geolibre-movecost/pages/builds`.

## Plugin registry submission — PR OPEN

**https://github.com/opengeos/geolibre-plugins/pull/54** (opened 2026-09-09,
branch `add-movecost` on fork `enzococca/geolibre-plugins`, clone at
`~/geolibre-plugins`, latest commit `e66d718` = 0.1.8 (PR title without a version number); approved by giswqs, who asked for the control icon to be centred and visible in dark mode — fixed in 0.1.4, replied on the PR): `plugins/movecost/` (plugin.json with
author/homepage, whitespace-minified index.js, style.css) plus the entry in
`plugin-registry.json` (categories Analysis/Archaeology/Terrain,
minGeoLibreVersion 2.9.0). `validate` and `minify:check` pass; CodeRabbit
review passed with no actionable comments; "Build and deploy preview" was
still pending (first-contributor workflow approval). Pages now serves 0.1.2,
matching the PR bundle. Two changes were needed: `PUBLISHED_WASM_REPO` in
`src/config.ts` as a built-in default (a registry copy has no `wasm-repo/`
beside it), and `__dirname` defined away in `vite.config.ts` (the registry
validator imports the bundle under Node; webR keeps a Node-only branch).
Registry updates later = bump version in plugin.json + registry entry,
`npm run minify`, new PR. Reason for going to the registry: manifest-URL
installs block on GeoLibre's trust hash after every republish and the iPad
build showed no reload control to re-accept.

## movecost 3.0.0 port — DONE (2026-09-09, `7374f0f`, version 0.2.0)

CRAN went to **3.0.0** on 2026-06-15 while the plugin ran 2.2; the audit that
found it also found that every install instruction said
`install.packages("movecost")`, which would have installed 3.0.0 and broken the
local R service (fixed first by pinning 2.2 in `aa6fdfe`, then superseded by
the port).

**The engine now speaks the 3.0 API.** `mcx_build_surface()` calls
`mc_surface()` once and caches the graph in `mcx_env$surface` under a signature
of DTM + barrier + every cost parameter; the analyses (`mc_paths`+`mc_accum`,
`mc_corridor`, `mc_network`, `mc_alloc`, `mc_boundary`, `mc_rank`) read it. One
surface at a time — the old one is dropped and collected before a new one is
built, and a new DTM download calls `mcx_forget_surface()`. Native suite:
13/13, and the whole synthetic run takes 0.2–0.8 s per analysis where 2.x took
tens of seconds.

Behaviour that changed, and is reflected in the UI and the guide:

* barriers moved onto the surface, so **allocation and ranking honour them**
  now (`supportsBarrier: true` everywhere);
* `mc_boundary()` takes **one limit per call** — the panel still offers a list
  and the engine loops, each extra limit being one pass over the cached graph —
  and returns **polygons** with `area`/`perimeter` instead of lines (result key
  `isolines`/`origins` → `boundaries` + `accumulated`);
* corridors gained the **"through"** formulation (`corridorMethod`), ranked
  paths a **detour penalty**, networks a numbered `nodes` layer;
* `breaks` became an **interval**, not a list of values;
* `irregular.dtm` and `use.corr` are gone;
* units: `mc_*` returns `units` columns that `jsonlite` cannot serialise —
  `mcx_plain_table()` strips the class (this was the only real surprise in the
  port);
* packages: raster, sp, gdistance, chron **out**; igraph and ggplot2 **in**
  (ggplot2 only because movecost imports it for plot methods the engine never
  calls). `r-backend/start.R` refuses < 3.0.0.

**WebAssembly.** `repo.r-wasm.org` still builds 2.2, so
`scripts/build-movecost-wasm.R` packages 3.0.0 for webR *without the rwasm
container*: movecost is `NeedsCompilation: no`, so a normal R 4.6 install is
byte-for-byte usable once the `Built:` metadata in DESCRIPTION and
`Meta/package.rds` is restamped `wasm32-unknown-emscripten`. The `.tgz` (2.8 MB)
sits in `build/wasm-repo` next to the rebuilt terra and is served from Pages;
the script aborts if a future movecost ever ships compiled code.
`scripts/test-wasm-install.mjs` serves that repo over HTTP, installs the stack
into webR under Node and runs `mcx_run()` itself — verified with movecost 3.0.0,
terra 1.9.46, sf 1.1.1, igraph 2.3.1, ggplot2 4.0.3.

**Verified live (2026-09-09).** The registry preview is unusable — its workflow
needs a maintainer to approve each run and the `opengeos/pages-preview` Pages
build keeps erroring — so `scripts/build-geolibre-preview.sh` reproduces it
locally: clone opengeos/GeoLibre, drop the plugin into
`apps/geolibre-desktop/public/plugins/`, `GEOLIBRE_APP_BASE=./ npm run build -w
geolibre-desktop`, serve `dist`. `scripts/capture-guide.mjs` then ran the whole
Pompeii walkthrough against it on 0.2.0 — plugin activated, layers loaded, DEM
downloaded, analysis in 11.8 s through the local R service, results drawn and
grouped — and `docs/guide/images/` is recaptured from that run.

`scripts/test-matrix.R` is the thorough check: every analysis with and without
a barrier, all 26 cost functions, the neighbourhoods, both time units,
cognitive slope, topographic distance, and the cache. All green.

**Two bugs the live run found, both fixed in `afd22d5`:**

1. `jsonlite`'s `auto_unbox` turned a one-line `log` into a bare string, so the
   panel's `log.join()` threw on every successful analysis — and one line is
   exactly what a cached-surface run produces. `mcx_log_out()` wraps it in
   `I()`; the panel accepts either shape.
2. Enzo's 422s came from the R service having been started at 10:23, before the
   movecost upgrade: `packageVersion()` read 3.0.0 from disk while the loaded
   namespace was still 2.2. `mcx_require()` now checks that `mc_surface()`
   actually exists in the loaded namespace and says "restart the R service".

**Barriers are rasterised by the cells they fall in.** A line laid exactly along
the DTM's grid lines touches almost none: on 50 m cells a wall on a row boundary
removed 16 graph edges and blocked nothing, the same wall 25 m higher removed
about 950. movecost's behaviour, not ours, and only round-coordinate fixtures
hit it — but it cost an hour to find, so the matrix test says so in a comment.

**Barrier bug, found from Enzo's own project file (`fc51b97`).** "Use drawings"
handed movecost every sketch, including the rectangle he had drawn to define
the study area — so the whole area was a barrier — and GeoLibre's sketches
layer mixes geometry types and carries list-valued `__gm_*` properties. terra
cannot build one SpatVector from mixed geometry, so `mc_surface()` died with
"[as,sf] coercion failed. You can try coercing via a Spatial* (sp) class", and
the underlying "nrow dataframe does not match nrow geometry" named no function.
Fixed on three fronts: the picker excludes the study-area drawing;
`mcx_tidy_vector()` strips Z/M, empty geometries and non-atomic columns from
every layer and `mcx_prepare_barrier()` buffers a mixed barrier by half a cell
so the lines become thin polygons over the same cells; and an unexpected error
now carries the call stack (captured with `withCallingHandlers`, since
`tryCatch` unwinds it first) plus a log line describing the inputs. The matrix
test covers a mixed line+polygon barrier with list columns and one with Z
coordinates.

**Group spam.** The same project had 21 empty "movecost · locations" groups:
raising the markers makes a new group each time and asks the host to remove the
old one, and that host ignores the call. The panel now gives up after two
orphans and reuses its group.

**`gm_temporary` explained (2026-09-10).** "There is no tile manager with ID
'gm_temporary'" is **MapLibre GL JS**, not GeoLibre and not us: `Map.isSourceLoaded(id)`
fires an `ErrorEvent` when `style.tileManagers[id]` is missing (found in
maplibre-gl 6.9.0's `maplibre-gl-dev.mjs`). `gm_temporary` is Geoman's
temporary drawing source — GeoLibre draws with Geoman, see `GEOMAN_SHAPE_PROPERTY`
in `packages/map/src/layer-sync.ts` — and something polls it once a frame, hence
dozens of identical lines 40 ms apart. It is logged, never thrown.

The trigger is a style rebuild dropping sources Geoman added straight to the
map, and what caused those rebuilds on our side was `raiseMarkers()`:
unregistering and re-registering both marker layers, twice per run. It now runs
only when `listLayers()` shows one of our layers actually above a marker. The
same churn produced the empty groups — a fresh `movecost · locations` on every
raise — and `groupHostLayers()` now never creates a second group under a name it
already holds. Two runs in the store-faithful host test must leave exactly one
locations group and no empty ones.

**Root cause pinned, then finished (2026-09-10).** The spam depends on the
host: with `moveLayersToGroup` available the old code reused its group and
behaved; without it, every grouping call fell through to `addLayerGroup` and the
layers followed the new group, leaving the old one empty. A local GeoLibre built
from `main` has the method, which is why two runs there showed one group and no
`gm_temporary` errors on both the old and the new bundle — the live A/B proved
nothing. The headless case did: the same store-faithful host with
`moveLayersToGroup` omitted gave **8** locations groups over three runs on the
old code, **1** on the reuse fix — and that remaining one was still wrong,
because a group that can only be filled at creation empties the first time the
markers are re-added and can never be refilled. Enzo saw exactly that on the
iPhone. So a group whose members get re-registered is now `volatile`, and on a
host without `moveLayersToGroup` it is not created at all: the markers stay
ungrouped, the terrain and the results still group. The test asserts zero.

That iPhone run (webR in the browser, 05:53–05:55) also carried **no
`gm_temporary` errors and no Geoman warnings at all**, which is the first
evidence that the churn fix did what it was meant to.

`scripts/check-layer-churn.mjs` drives a real GeoLibre through two analyses and
counts the groups in the Layers panel plus every `tile manager with ID` line on
the console; keep it for the next host-level question.

**Console warnings from the browser run, both fixed at source (`798e8cc`).**
The ~30 lines of "code for methods in class Rcpp_SpatRaster was not checked for
suspicious field assignments" come from `methods` when R's recommended
`codetools` is absent, which it is in the WebAssembly image; it is now installed
alongside the analysis packages. "Can't mount archive, no VFS metadata found"
was about our own movecost tarball: webR *mounts* an archive carrying a
`.vfs-index.json` of byte ranges and extracts one that does not, and
`utils::tar()` writes no such index. `scripts/pack-wasm-tgz.py` now builds the
archive with it — and reads its own output back to check every range, because
`TarInfo.offset_data` is only filled in when reading an archive: the first
attempt shipped an index of zeros, mounted perfectly, and handed R the wrong
bytes ("readRDS(file): unknown input format" from a package that looked fine).
Verified in webR under Node: neither warning, and the install is a little faster
for being mounted.

**Host sprites that do not arrive.** The same run logged three
`Image "..." could not be loaded` warnings, one per style the host has to
generate a sprite for: `geolibre-marker-triangle-dc2626-22` when the
destination markers appear, and `geolibre-line-decoration-arrow-e11d48-12` /
`-f97316-12` when the paths do. One each, at the moment the layer is added, and
the shapes rendered correctly in the desktop build — so this looks like
MapLibre complaining before the host has finished generating the sprite. Worth
a second look only if a triangle or an arrow is ever actually missing.

**Still open:** GeoLibre Desktop logged
`Image "geolibre-marker-triangle-dc2626-22" could not be loaded` once. It did
not reproduce in the local web build, where the red triangles render correctly.

**Gotcha for future sessions:** R on the Mac only works under
`do shell script` with `PROJ_LIB=/opt/homebrew/share/proj` (and `GDAL_DATA`)
exported, otherwise terra dies with "Cannot find proj.db".

## Demo video for social media (2026-09-09)

`scripts/record-demo.mjs <geolibre-url> <data-base-url> [outdir]` records a
screencast of the live app (Playwright `recordVideo`, 1440x900) and writes
`timeline.json`: one beat per moment with its caption, the region to frame
(`full`/`panel`/`map`/`layers`, rectangles read from the DOM at the end) and a
speed. A synthetic cursor is injected into the page — a real recording shows
no pointer — and glides before each click. `scripts/edit-demo.py video
build/demo` (run in the cloud: PIL + ffmpeg) cuts it into a 1080x1080 frame
with a title bar, a caption band, per-beat zoom, a progress line and title/end
cards. `scripts/edit-demo.py stills <dir>` builds the same frame from the
guide screenshots. Result: `movecost-demo-1080x1080.mp4`, 58 s, 3.8 MB.

Lessons for the next run: `networkidle` never fires (the map keeps streaming
tiles) — wait for `.maplibregl-canvas` and the toolbar instead; under the
screencast the app needs ~70-100 s to boot, and a 1920x1080 viewport plus webR
white-screened the renderer mid-download, so the recording is 1440x900 with the
DEM at detail level 11. Beats that wait on the machine are sped up 7-18x in the
edit; the analysis is kept at 3x so the progress bar reads.

## User guide (2026-09-09)

`docs/guide/index.html` (English) published at
**https://enzococca.github.io/geolibre-movecost/guide/** and linked from the
README; walkthrough data in `docs/guide/data/` (Pompeii Forum origin,
Herculaneum + Villa Poppaea destinations, Vesuvius study area 14.32–14.52 ×
40.72–40.84). Screenshots (`docs/guide/images/`) are captured by
`scripts/capture-guide.mjs <geolibre-url> <data-base-url> [outdir]` with
Playwright on the Mac (`npx playwright install chromium chromium-headless-shell`
done) against the PR preview `https://opengeos.org/pages-preview/geolibre-plugins/pr-54/`
(GeoLibre main + the PR's registry): activate plugin, Add Data → Vector Layer
URL ×3, study area from the layer select, Download DEM, points from layers,
Run; whole flow ~2.5 min, analysis 28 s in webR. Post-process here with PIL
(1600 px JPEG for map shots, cropped PNG for panel clips).

Fixes that came out of the captures (0.1.6–0.1.8): the tile download fetched
one zoom finer than the menu level (4× cells) — now zoom = menu level; study
area can come from an existing polygon layer; the panel polls `listLayers()`
every 1.5 s and re-renders when layers change (no host event); markers are
raised above each run's results — both removed then re-added, because
GeoLibre anchors a group where its first member sits (`normalizeGroupContiguity`)
and re-adding one at a time dragged the new group down; groups are now
`movecost · terrain`, `movecost · locations`, `movecost · <analysis> #n`.
Host test 22/22 incl. a store-faithful ordering check.

## Mobile updates: versioned manifest + bundle names (2026-09-09)

Enzo could not get an updated build onto the iPad: GeoLibre pins the bundle
hash per manifest URL, the pin is only dropped when a *loaded* plugin's URL is
removed (a plugin held back by a changed hash is never loaded, so remove +
re-add keeps the stale pin), the mobile UI offers no reload, and the WebView
additionally caches `dist/index.js` by URL. `publish-pages.sh` now also writes
`plugin-<version>-<build>.json` → `dist/index-<build>.js` / `style-<build>.css`
(build = sha256 prefix of the bundle) and links it from the site index; the
iPad gets that URL (remove old ones first). Current: `plugin-0.1.8-7987d7b5.json` — Enzo confirmed it works on the iPad ("bene funziona"). 0.1.5 also prints "Plugin <version>" in the panel header (`src/version.ts`, checked by the packager) and makes "Use current view" fall back to `getMap().getBounds()` because `getViewBounds` post-dates GeoLibre 2.9.0 — the missing button on the iPad app was a host-API difference, not a stale bundle.

## Memory budget for in-browser DEMs (0.1.3, 2026-09-09)

Enzo hit "memory exhausted" / "cannot allocate vector of size 150 Mb" on the
iPad with a larger drawn area: webR's heap is a few hundred MB there and
movecost/gdistance builds a sparse transition matrix (cells × directions,
copied several times). Fix: `cellBudget()` in the panel — 150k cells on a
tablet, 400k in a desktop browser, 4M with the R service; `estimateGrid` /
`zoomWithinBudget` in `terrain-tiles.ts` show the expected DEM size under the
Detail select and the download automatically drops to the finest level that
fits (message says which). `maxCells` is also passed to `mcx_grid_to_dtm`,
which aggregates an oversized grid as a safety net; the engine keeps only the
latest DTM handle, runs `gc(full=TRUE)` after every request and appends a
remedy to out-of-memory errors (`mcx_memory_hint`, mirrored by
`withMemoryHint` in the panel). Mobile defaults to 8 directions. Native suite
11/11, host test 20/20. PR #54 updated to 0.1.3 (`7463d2b`); preview check
now green (the earlier red was a Pages timeout). Pages serves 0.1.3.

## Map integration (rewritten 2026-09-09)

Enzo reported: clicks placed no visible point, cost rasters never appeared,
and layers were not grouped. Root cause of the invisible rasters: layers added
straight through `getMap().addLayer()` are unknown to GeoLibre's layer store,
and `MapController.getBasemapStyleLayers()` then classes them as basemap and
pins their opacity/visibility to the basemap's.

Fix (`src/map/host-layers.ts`, `src/map/styles.ts`): every plugin layer goes
through `app.registerExternalNativeLayer()` with an **empty `nativeLayerIds`**,
which makes the host render it itself from `type` + `source`/`geojson`
(verified in GeoLibre 2.9.0 `packages/map/src/layer-sync.ts::syncLayer`):

- markers: `type: "geojson"` + `style` — origins green circles, destinations
  red triangles (`markerShape: "triangle"`), labelled `O1…`/`D1…` via
  `labels.field = "mcx_id"`; fixed ids `movecost-origin` / `movecost-destination`
  re-registered on every click (updates in place, keeps group);
- rasters: canvas → data URL → `type: "image"` with corner `coordinates`
  (the Raster Georeferencer's layer kind), host opacity slider works;
- results: styled per layer key (`resultStyle`), rasters registered before
  vectors;
- groups: `movecost · input` (DEM + markers), `movecost · <analysis> #n` per
  run; earlier runs are kept for comparison;
- removal: `app.unregisterExternalNativeLayer(id)` removes ANY store layer
  (there is no public `removeLayer`); deactivate removes only the markers.

Synced, committed (`82e1551`) and published (gh-pages `33272a3`, Pages build verified serving the new bundle) on 2026-09-09; desktop install refreshed. Fallbacks ("migliora anche il fallback sull'immagine"): the raw
`getMap()` overlay now self-heals against the host's basemap passes and style
reloads (watches `styledata`/`style.load`), and every raster result keeps a
thumbnail + value range in the results list, which is the rendering when there
is no map at all.

`npm run test:host` (`scripts/test-host-layers.mjs`, Playwright + mock host)
checks the whole flow incl. the fallbacks: 20/20 pass. In the cloud sandbox run it with
`MCX_CHROMIUM=/opt/pw-browsers/chromium`.

## What it is

A GeoLibre plugin exposing Gianmarco Alberti's **movecost** R package: least-cost
paths, corridors, networks, cost allocation, isochrones, and ranked alternative
paths, with all 27 published cost functions.

## Terrain: three routes, download first

1. **Download once** — drawn polygon or current view. With the R service:
   elevatr (`POST /dem`). In the browser: the page fetches AWS **Terrarium**
   tiles itself (`src/map/terrain-tiles.ts`, 256 px, one zoom finer than the
   elevatr labels), decodes them to a Float32 Web Mercator grid, and
   `mcx_grid_to_dtm()` reprojects to UTM at the true ground cell size, masks
   to the polygon. Under webR the result is **kept in the R session by handle**
   (`dtmHandle`), not written: terra::writeRaster never returns in webR above
   ~2000 cells, whatever the options. The R service writes the GeoTIFF
   (`POST /grid`).
2. **Use the area directly** — movecost's own `studyplot`; R service only.
3. **Upload a GeoTIFF.**

The DTM is previewed on the map as a host image layer (`DEM — <name>`) with a
show/hide toggle.

## Architecture: two backends, one engine

`src/engine/movecost-engine.R` is the single R implementation; both backends
implement `AnalysisBackend` and the panel reports which one it got.

1. **Local R service** (`r-backend/`, plumber on `127.0.0.1:8787`) — fast path.
   Not probed on mobile (`isMobileDevice()`).
2. **webR in the page** — fully working, no R anywhere. webR loads from
   **jsDelivr** (`cdn.jsdelivr.net/npm/webr@0.6.0/dist/`): cross-origin base →
   blob worker (`worker-src blob:` ok), `importScripts` of R.js allowed by
   GeoLibre's `script-src` for jsdelivr/npm. The plugin auto-discovers
   `wasm-repo/` next to its manifest via `resolvePluginAssetUrl` and consults
   it first. Measured on the Vesuvius box: tiles→DTM 14.6 s, preview 8.8 s,
   paths (Tobler, 8 dir) 7.6 s, same walking time as the R service.

## Installing

- Desktop: zip via Manage Plugins, or `npm run install:geolibre`.
- **iPad / Android: manifest URL only.** "Choose .zip" fails on every Tauri
  build (native picker path → Rust copy the mobile sandbox refuses; UI shows
  the generic "Impossibile installare il plugin"). Paste the Pages manifest URL
  under Settings → Manifest URLs. Verified: the plugin loads on the iPad. After
  every republish GeoLibre reports the bundle "changed since you last trusted
  it" until re-accepted in Settings → Plugins.
- `scripts/serve-plugin.sh --tunnel` gives a temporary cloudflared URL.

## The terra story (resolved)

Upstream terra wasm fails in webR: `gdal-config --cflags` in the sysroot passes
`-DPROJ_RENAME_SYMBOLS`, terra's seven direct PROJ calls become
`internal_proj_*`, hidden in libgdal.a; libproj.a exports plain names. Fix in
`scripts/build-terra-wasm.sh`: keep the define (cancelling it collides terra's
bundled `geod_*` with PROJ's) and map the seven entry points back with
`-Dinternal_X=X` + `LIBS += -lproj`, injected into rwasm's `webr-vars.mk`
(`R_MAKEVARS_USER` points there). Worth an issue on r-wasm/webr.

## Verified

- Native R suite 10/10 (six analyses, preview, Mercator grid → UTM DTM, errors)
- R service end to end from a browser: analyses, /dem, /grid, /preview, studyplot
- webR end to end with no R: terra/raster/gdistance/movecost load; tile DEM;
  preview; least-cost paths
- Bundle passes GeoLibre's install rules and blob-import load path
- Plugin loads inside GeoLibre on the iPad via manifest URL
- Host-layer flow (markers, rasters, groups, fallbacks) against a mock host, 20/20

Not verified: running an analysis inside the GeoLibre window itself (computer
access declined). `VERIFY.md` is the manual checklist.

## Key files

| Path | What |
| --- | --- |
| `src/engine/movecost-engine.R` | The R engine — analyses, DEM download, grid→DTM, preview, handles |
| `src/engine/backend.ts` | Backend interface, HTTP backend, probe, summary parsing |
| `src/engine/webr-runtime.ts` | webR backend (handles, grid, preview) |
| `src/map/host-layers.ts` | Host-owned layers: markers, image rasters, groups, removal |
| `src/map/styles.ts` | Marker and result styles |
| `src/map/terrain-tiles.ts` | Terrarium tile fetcher/decoder |
| `src/config.ts` | webR base URL (jsDelivr), repository list |
| `src/ui/panel.ts` | The workspace panel |
| `r-backend/` | plumber service + README |
| `scripts/build-terra-wasm.sh` | terra WebAssembly build with the PROJ fix |
| `scripts/serve-plugin.sh` / `publish-pages.sh` | Hosting |
| `scripts/test-host-layers.mjs` | Headless host-integration test (`npm run test:host`) |
| `scripts/wasm-missing-symbols.py` / `check-plugin-zip.py` | Diagnostics |
| `scripts/test-engine.R` | Native test suite |

R packages the service needs: plumber, jsonlite, sf, terra, raster, sp,
movecost, plus elevatr and **progress**. On macOS with the CRAN build of R,
`PROJ_LIB` must point at sf's bundled PROJ database; `start.R` sets it.
