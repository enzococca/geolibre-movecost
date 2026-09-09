# Architecture

## The problem

`movecost` is an R package. GeoLibre plugins are ES modules running inside the
app's webview. Nothing in the plugin API lets a plugin start a process, so the R
has to run somewhere else — and the plugin supports two somewheres.

**Local R service** (`r-backend/`, the working path today). A small
[plumber](https://www.rplumber.io) API on `127.0.0.1` sources the same
`movecost-engine.R` and answers one HTTP request per analysis. Real movecost,
native speed, DTMs as large as R can handle.

**webR in the page.** R itself compiled to WebAssembly, with `movecost`
installed from `repo.r-wasm.org`. No R installation, nothing to start. This path
is complete except that the published `terra` wasm binary will not load — see
[WEBR-FINDINGS.md](WEBR-FINDINGS.md) and [TERRA-WASM.md](TERRA-WASM.md).

The panel probes for the local service when it opens and says which backend it
got. Either way the analysis stays on the machine: nothing is uploaded anywhere.

```
┌───────────────────────── GeoLibre webview ──────────────────────────┐
│  Right panel (DOM)                                                  │
│  ├── DTM picker            AnalysisBackend                          │
│  ├── point pickers    ──▶  (probed once when the panel opens)       │
│  ├── cost-function form         │                                   │
│  └── results list   ◀───────────┤                                   │
└─────────────────────────────────┼───────────────────────────────────┘
                                  │
              ┌───────────────────┴────────────────────┐
              ▼                                        ▼
   HttpBackend  ──POST /run──▶            MovecostEngine (webR)
   (preferred when it answers)            ├── boot R 4.6 wasm
              │                           ├── install packages
              ▼                           ├── write inputs to the VFS
   ┌── plumber on 127.0.0.1 ──┐           └── source + call mcx_run()
   │  R 4.6 (native)          │                        │
   │  movecost 2.2, terra,    │                        ▼
   │  sf, raster, gdistance   │            ┌─── webR worker ────┐
   │  movecost-engine.R       │            │  same engine.R      │
   └──────────────────────────┘            └─────────────────────┘
```

Both backends implement `AnalysisBackend` in `src/engine/backend.ts`, and both
end at the same `mcx_run()` with the same JSON on the wire — so a result looks
identical whichever one produced it.

## Request / response contract

`src/engine/movecost-engine.R` exposes exactly one entry point:

```r
mcx_run("/movecost/run-1/request.json")   # writes request.response.json beside it
```

The request names files already written into webR's emulated filesystem:

```jsonc
{
  "analysis": "paths",              // paths | corridor | network | allocation | boundary | rank
  "dtmPath": "/movecost/run-1/dtm.tif",
  "originPath": "/movecost/run-1/origin.geojson",
  "destinPath": "/movecost/run-1/destin.geojson",   // or null
  "barrierPath": null,
  "params": { "funct": "t", "time": "h", "move": 16 }
}
```

The response inlines the results:

- **vectors** — GeoJSON text, already reprojected to EPSG:4326, one entry per
  result layer (`lcps`, `isolines`, `network`, `boundaries`, …).
- **rasters** — a base64 little-endian `Float32` array plus width, height and the
  WGS84 bounds. NoData is `NaN`. This avoids putting a GeoTIFF decoder in the
  bundle and lets the panel choose its own colour ramp; `decodeRaster()` and
  `renderRasterToCanvas()` in `src/map/raster-overlay.ts` do the painting.
- **tables** — cost matrices and destination costs, shown verbatim in the panel.

Keeping the boundary at a JSON file (rather than passing R objects through
webR's object bridge) has one practical benefit: the same engine runs unchanged
under a native `Rscript`, which is how `scripts/test-engine.R` verifies it
without a browser.

## Getting the terrain

The panel offers three routes, download first:

- **Download once** — a WGS84 polygon goes to `POST /dem`, which calls
  `elevatr::get_elev_raster()` against the AWS terrain tiles, projects the result
  to the UTM zone of the area's centroid, clips it to the polygon, and returns
  the GeoTIFF bytes. From that point the DEM is indistinguishable from an
  uploaded one, so nothing downstream has a second code path.
- **Use the area directly** — the polygon is sent with the analysis instead, as
  `studyplot`, and `movecost` resolves it into elevation itself (its documented
  `studyplot` + `z` path: `elevatr::get_elev_raster()` then `raster::crop()`).
  One fewer step, but it downloads inside every run.
- **Upload** — the user's own GeoTIFF.

Measured on the same area and points (Vesuvius, 10 × 8 km, zoom 11, Tobler):
downloading once then running takes 3 s + 2.4 s and gives 02:09:29; the direct
path takes 4.2 s per run and gives 02:09:06 — the small difference is elevatr's
`crop` versus our clip. So the two agree, and the choice is only about whether
the download is paid once or every time.

Whichever route produced it, the DTM is then sent to `POST /preview`, which
returns the same raster payload shape the analyses use. The panel paints that
with `addRasterOverlay()`, so seeing the terrain costs no new client-side
GeoTIFF decoder.

Only the local R service implements `fetchDem`; the webR backend leaves it
undefined and the panel hides the option, because the browser runtime has no
route to the tile server. `previewDtm` is implemented by both.

## CRS handling

`movecost` derives slope from the DTM, so the grid has to be projected in metres.
The engine reprojects a geographic DTM to the UTM zone of its own centroid
(`mcx_prepare_dtm`), transforms every input layer into that CRS, and transforms
results back to EPSG:4326 on the way out.

`movecost` 2.x returns `sp` objects built on `raster`; round-tripping them
through `sf` sometimes loses the CRS, so both `mcx_sf_to_geojson()` and
`mcx_raster_payload()` restore the analysis CRS as a fallback before
reprojecting. Without that every result comes back as "missing crs".

## Why the results are added the way they are

Vector results go through `app.addGeoJsonLayer()`, so they become first-class
entries in the Layers panel and persist with the project.

The host has native layer helpers for tiles, COGs and Zarr stores, but none for
an in-memory grid. Raster results are therefore painted onto a canvas and added
as a MapLibre `image` source through `app.getMap()`. Those layers do **not**
appear in the Layers panel, which is why the plugin panel keeps its own list and
removal button. If a future host version grows an "add raster from array"
helper, `addRasterOverlay()` is the single place to change.

Every optional host member is called with optional chaining and has a fallback:
no `getMap()` means no click-to-place and no raster overlay, but vector results
still land on the map.

## movecost 2.x vs 3.x

CRAN currently carries `movecost` 3.0.0, which replaced the standalone
`movecost()` / `movecorr()` / … functions with a compute-once design
(`mc_surface()` then `mc_paths()`, `mc_corridor()`, …). The WebAssembly
repository is behind CRAN and currently builds **2.2**, so the engine targets the
2.x API, which is what actually installs in the browser today.

The switch, when the wasm build catches up, is contained in the
`mcx_analysis_*()` functions: the request/response contract and the whole
TypeScript side stay as they are.
