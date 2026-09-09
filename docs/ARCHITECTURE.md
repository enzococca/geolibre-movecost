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

Only the local R service implements `fetchDem` (elevatr, in R). The webR
backend gets the same feature a different way, `dtmFromGrid`: the page fetches
AWS **Terrarium** tiles itself (`src/map/terrain-tiles.ts` — public bucket,
CORS, height encoded as `R*256 + G + B/256 − 32768`), decodes them on a canvas
into a Float32 grid in Web Mercator, and hands that to `mcx_grid_to_dtm()`,
which reprojects it to UTM at the true ground cell size (Mercator metres ×
cos φ), masks it to the polygon, and writes the GeoTIFF. From there the DTM is
an ordinary one. The tile zoom is the level the menu names: elevatr's `z`
and the Terrarium tiles share the 256 px slippy-map scale (elevatr's zoom 12
gave 28.6 m cells at 40.8° N, i.e. 38 m × cos φ — the same grid the tiles give
at zoom 12; an earlier build fetched one level finer and produced four times
the cells the menu promised). Same Vesuvius box, Tobler: 02:08:33 this way,
02:09:29 via elevatr — the difference is the resampling, not the terrain.

`previewDtm` is implemented by both backends; the R service also exposes the
grid route as `POST /grid` for symmetry.

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

Every layer the plugin draws — terrain, origin / destination markers, result
vectors and cost rasters — is registered with the host through
`app.registerExternalNativeLayer()` (`src/map/host-layers.ts`), so it is a
first-class entry in the Layers panel, sits in a group, can be hidden, restyled
and removed there, and persists with the project.

The documented use of that call is a layer the plugin already added to the map
itself. We use it differently: with an **empty** `nativeLayerIds` the host does
not treat the layer as external and renders it through its own pipeline from
the registration's `type` and `source`/`geojson` (GeoLibre 2.9.0,
`packages/map/src/layer-sync.ts`, `syncLayer`). That gives two things the public
API otherwise lacks:

- a GeoJSON layer **with a chosen style** (`style: Partial<LayerStyle>`), which
  is how origins become green circles and destinations red triangles, and why
  paths, isolines and zones arrive coloured rather than in the default blue;
- a raster from an in-memory grid: the payload is painted onto a canvas and
  registered as `type: "image"` with a data-URL `source` and corner
  coordinates — the same layer kind GeoLibre's own Raster Georeferencer
  produces — so the host owns the MapLibre image source and its opacity slider
  drives the layer natively.

The earlier approach, `getMap().addSource()/addLayer()` straight on MapLibre,
is why the cost rasters were invisible: a style layer the store does not know
is classed as basemap by `MapController.getBasemapStyleLayers()`, and the
basemap-opacity and basemap-visibility passes then pin it to the basemap's
state. That path survives only as a fallback in `addRasterOverlay()`.

Removal uses `app.unregisterExternalNativeLayer(id)`, whose host implementation
removes any store layer by id. Groups come from `addLayerGroup` /
`moveLayersToGroup`: one **movecost · input** group for the DEM and markers
(marker layers are re-registered under fixed ids on every click, which updates
the layer in place and keeps its group), and one group per run for the results,
so earlier runs remain for comparison.

Every optional host member is called with optional chaining and has a
fallback, and rasters degrade in three steps:

1. a host-owned `image` layer (above);
2. without `registerExternalNativeLayer`, a raw MapLibre overlay through
   `getMap()` — `addRasterOverlay()` in `src/map/raster-overlay.ts`. Because
   the host classes such a layer as basemap, the overlay watches `styledata`
   and `style.load` and reasserts itself: it re-adds source and layer after a
   basemap change, restores its opacity and visibility when a host pass
   changed them, and moves itself back to the top of the stack, until
   `remove()` unhooks it;
3. without the map at all, a thumbnail with the value range inside the panel's
   results list (`renderRasterThumbnail()`), which is in fact kept for every
   raster result as a readout.

No `getMap()` also means no click-to-place; without the registry the markers
are plain circle layers on the map and the vectors go through
`addGeoJsonLayer`.

## movecost 2.x vs 3.x

CRAN carries **movecost 3.0.0** (published 2026-06-15); the plugin runs **2.2**
on both paths. Checked 2026-09-09: `repo.r-wasm.org` (R 4.6) still builds 2.2,
and the local R service pins 2.2 too.

3.0.0 is a redesign rather than an update. `mc_surface()` builds the cost graph
once and every analysis reuses it (`mc_accum`, `mc_paths`, `mc_corridor`,
`mc_boundary`, `mc_alloc`, `mc_network`, `mc_rank`), multi-origin work goes
through batched igraph Dijkstra queries, the stack moves to terra + sf + igraph
(raster, sp, gdistance, chron and the hard elevatr dependency are gone), and
plotting is decoupled into ggplot2 methods. The 26 cost functions are
unchanged. The 2.x entry points — `movecost()`, `movecorr()`, `movealloc()`,
`movebound()`, `movenetw()`, `moverank()` — survive only as **defunct stubs**
that raise an error naming their replacement, so an engine written for 2.x does
not misbehave on 3.0.0: it stops. `mcx_require()` checks the version and says
so before anything else runs, and the install instructions pin 2.2
(`remotes::install_version("movecost", "2.2")`) — `install.packages("movecost")`
would otherwise fetch 3.0.0 and break the service.

Porting is worth doing when it comes up: all four dependencies of 3.0.0 already
have WebAssembly builds in the upstream repository (igraph 2.3.1, ggplot2
4.0.3, terra 1.9-27, sf 1.1-1), and movecost itself is pure R
(`NeedsCompilation: no`), so it can be added to `build/wasm-repo` with the
same rwasm pipeline as terra. The gain would be real in the browser: four
packages fewer to download, no gdistance conductance matrix rebuilt per call,
and batched queries for the multi-origin analyses that are slowest today.

The change is contained in the `mcx_analysis_*()` functions: the
request/response contract and the whole TypeScript side stay as they are.
