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
   │  movecost 3.0, terra,    │                        ▼
   │  sf, igraph              │            ┌─── webR worker ────┐
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

`movecost` 3.0 takes and returns `sf` and `terra` objects directly, so nothing
is coerced to `sp` any more. The CRS can still go missing on a round trip, so
`mcx_sf_to_geojson()` and `mcx_raster_payload()` keep restoring the analysis CRS
as a fallback before reprojecting. Measured columns — boundary areas, path
lengths — arrive as `units` objects, which `jsonlite` cannot serialise;
`mcx_plain_table()` strips the class and the number travels plain, with the unit
documented rather than encoded.

`log` is written through `mcx_log_out()`, which wraps it in `I()`. Without that,
`jsonlite`'s `auto_unbox` turns a one-line log into a bare string and the
panel's `log.join()` throws — and one line is exactly what a cached-surface run
produces, so the port made a latent bug the common case.

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

## The cost surface, and why it is built once

movecost 3.0 (CRAN, 2026-06-15) is a redesign rather than an update.
`mc_surface()` turns the DTM into a directed igraph of per-cell movement costs,
and every analysis reads that graph: `mc_accum`, `mc_paths`, `mc_corridor`,
`mc_boundary`, `mc_alloc`, `mc_network`, `mc_rank`. In 2.x each of those
functions rebuilt the conductance matrix from scratch, so a network between n
sites meant n or more redundant constructions.

The engine follows that shape. `mcx_build_surface()` keeps the graph in
`mcx_env$surface` under a signature made of the DTM identity, the barrier and
every cost-function parameter; a run whose signature matches reuses it and logs
that it did. Only one surface is ever held — inside webR the graph is the
largest object in the heap, so the previous one is dropped and collected before
a new one is built, and downloading a new DTM invalidates it
(`mcx_forget_surface()`).

What this buys, on the same terrain and cost function: a second destination, a
second cost limit, or switching a corridor from "reach" to "through" costs a
Dijkstra pass instead of a rebuild. The native suite shows the reuse directly —
`scripts/test-engine.R` fails if a run that changed nothing structural
rebuilds the graph.

Three consequences follow through the rest of the plugin:

* **Barriers belong to the surface**, not to each analysis, so every analysis
  honours them — including allocation and ranking, which movecost 2.x could
  not.
* **`mc_boundary()` takes one cost limit per call.** The panel still offers a
  list of them, and the engine loops: with the graph already built, each extra
  limit costs only its own pass. Boundaries come back as polygons with `area`
  and `perimeter`, where 2.x returned lines.
* **A barrier is rasterised by the cells it falls in**, so a line laid exactly
  along the DTM's own grid lines touches almost none of them. On an 80x80 grid
  of 50 m cells, a wall on a row boundary removed 16 graph edges and blocked
  nothing; the same wall 25 m higher removed about 950 and raised the crossing
  cost by a fifth. This is movecost's behaviour, not the plugin's, and it only
  bites fixtures with round coordinates — but it is why
  `scripts/test-matrix.R` puts its wall through the middle of a row.
* **The dependency list changed**: terra + sf + igraph + ggplot2 in, and
  raster, sp, gdistance and chron out. ggplot2 is there because movecost
  imports it for its plot methods; the engine never calls them, since 3.0
  finally separates computing from drawing.

## movecost for WebAssembly

`repo.r-wasm.org` still builds movecost 2.2, so the plugin ships 3.0.0 in its
own `build/wasm-repo`, consulted before upstream (`src/config.ts`).

It does not need the rwasm container that terra needs.
`scripts/build-movecost-wasm.R` installs the CRAN source with a normal R 4.6 —
movecost is `NeedsCompilation: no`, so nothing is compiled and R's lazy-load
databases are portable across platforms and word sizes — restamps the `Built:`
metadata in `DESCRIPTION` and `Meta/package.rds` as
`wasm32-unknown-emscripten`, writes the `.tgz` next to the rebuilt terra and
regenerates the index. The script refuses to run if a future movecost gains
compiled code, which is exactly when the shortcut would stop being sound.

`scripts/test-wasm-install.mjs` is the check that matters: it serves
`build/wasm-repo` over HTTP, installs the whole stack into webR under Node
against that repository plus upstream, and runs `mc_surface()` and `mc_paths()`
on a synthetic DTM. Verified 2026-09-09 with movecost 3.0.0, terra 1.9.46,
sf 1.1.1, igraph 2.3.1 and ggplot2 4.0.3.

