# movecost for GeoLibre

Slope-dependent cost analysis inside [GeoLibre](https://geolibre.app), powered by
Gianmarco Alberti's [**movecost**](https://cran.r-project.org/package=movecost)
R package.

The plugin runs movecost through a small R service on your own machine
(`r-backend/`), and carries a second, zero-install backend that runs R itself as
WebAssembly in the page. The in-browser path is complete except for one upstream
problem — the published `terra` WebAssembly binary will not load — so **the local
R service is the working backend today**. The panel probes for it when it opens
and tells you which one it got. See [docs/WEBR-FINDINGS.md](docs/WEBR-FINDINGS.md).

| Analysis | movecost function | What you get |
| --- | --- | --- |
| Least-cost paths | `movecost()` | Accumulated cost surface, paths to each destination, cost isolines |
| Least-cost corridor | `movecorr()` | The band of terrain where movement between two places is cheap |
| Least-cost network | `movenetw()` | Paths between many locations, all pairs or neighbours, plus a cost matrix |
| Cost allocation | `movealloc()` | Territories: every cell assigned to its cheapest origin |
| Cost boundaries | `movebound()` | Isochrones — "one hour's walk from here" — with their areas |
| Ranked paths | `moverank()` | Several plausible routes, ranked optimal to sub-optimal |

All 27 movecost cost functions are available: Tobler and its variants,
Irmischer-Clarke, Márquez-Pérez, Uriarte González, Marín Arroyo, Alberti,
Rees, Kondo-Seino, Tripcevich, the wheeled-vehicle critical-slope function, the
abstract-cost functions, and the metabolic ones (Pandolf, Minetti, Herzog,
Van Leusen, Llobera-Sluckin, Ardigò, Hare).

## Set up the R service

Once:

```r
install.packages(c("plumber", "movecost", "sf", "terra", "raster", "sp", "jsonlite"))
install.packages(c("elevatr", "progress"))   # for "draw an area and download a DEM"
```

Then, whenever you want to use the plugin:

```bash
Rscript r-backend/start.R          # http://127.0.0.1:8787
```

Details, ports and troubleshooting: [r-backend/README.md](r-backend/README.md).

## Install the plugin

**From a packaged bundle**

```bash
npm install
npm run package          # -> build/movecost-0.1.0.zip, then checks it
```

Open GeoLibre → *Manage Plugins* → install from the zip. Works on desktop and
mobile; extra plugin folders are desktop-only.

`npm run package` runs `scripts/check-plugin-zip.py` on the result, which applies
GeoLibre's own install-time rules — where the manifest may sit, which fields are
required, how `entry` and `style` resolve, the 50 MB cap — and reports every
reason the host would refuse the archive rather than stopping at the first. Run
it on its own with `npm run verify:zip`.

The packaged `plugin.json` deliberately carries **only** the documented manifest
fields. Catalogue metadata (author, homepage, categories, `minGeoLibreVersion`)
lives in `plugin-registry-entry.json`: the current host ignores unknown manifest
keys, but an older build need not, and a refused install does not say which key
caused it. The packaging script fails if the two ever drift.

**Straight into a local GeoLibre Desktop**

```bash
npm run install:geolibre           # finds the app data folder itself
GEOLIBRE_PLUGIN_DIR=/path/to/plugins npm run install:geolibre
```

Restart GeoLibre and enable **movecost** in *Manage Plugins*.

## Use

1. Open the panel from the map button (top-right) or the *movecost* toolbar menu.
2. Get a **DTM**. Two ways, in the order the panel offers them:
   - **Draw an area and download a DEM** — draw a polygon (or press *Use current
     view*), pick a detail level, and elevation comes from the AWS terrain tiles
     via `elevatr`, projected to the right UTM zone. A 10 × 8 km area at
     ~29 m/cell arrives in about 3 seconds.

     *Download DEM* fetches it once and keeps it, which is what you want as soon
     as you compare cost functions on the same terrain. *Use area directly* skips
     the download and hands the polygon to movecost as its own `studyplot`, so it
     downloads inside every run — quicker for a single analysis (4 s), slower
     from the second one on.
   - **Load a GeoTIFF from disk** — your own DTM. Projected in metres is ideal;
     a geographic one is reprojected automatically.

   Either way the terrain is drawn on the map as soon as it is loaded, so you can
   see you got the right area before running anything. *Hide terrain* takes it
   off again.
3. Set the **locations** — click on the map, use the current selection, use the
   draw tools, or pull points from an existing layer. Barriers (lines or
   polygons) are optional.
4. Pick the **analysis** and the **cost function**. The form only asks for the
   walker parameters the chosen function actually uses.
5. **Run.** With the local R service, a 120 × 120 DTM answers in well under a
   second and ranked paths in a few seconds.

If the panel says *In-browser R* instead of *Local R service*, start the service
and press **Recheck**.

Vector results are added as normal GeoLibre layers. Raster results — accumulated
cost, corridors, allocation — are drawn as map overlays and listed in the panel,
since the host has no Layers-panel entry for an in-memory grid.

### Keeping runs fast

Cost-distance work is quadratic in the number of cells. A DTM of roughly
300 × 300 to 600 × 600 cells answers in seconds; several thousand cells a side
will take minutes in WebAssembly. Clip and resample the DTM to the study area
first, and start with 8 movement directions before moving to 16.

## Develop

```bash
npm install
npm run typecheck
npm run build            # dist/index.js + dist/style.css, self-contained
npm run serve:demo       # browser harness on http://localhost:5174
```

The demo page needs its fixture first:

```bash
Rscript scripts/make-demo-dtm.R      # writes examples/public/{dtm.tif,points.json}
```

### Testing the R engine without a browser

The engine is plain R, so it runs under a native `Rscript` with the same
`movecost` version the browser installs:

```bash
Rscript scripts/test-engine.R
```

It builds a synthetic DTM, exercises every analysis, checks the raster payloads
round-trip as `Float32`, and exits non-zero on failure.

> On macOS with the CRAN build of R, set `PROJ_LIB` first if you see
> "Cannot find proj.db":
> `export PROJ_LIB=/Library/Frameworks/R.framework/Resources/library/sf/proj`

## How it works

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the two backends, the
  request/response contract, CRS handling, and why raster results take a
  different path from vector ones.
- [docs/WEBR-FINDINGS.md](docs/WEBR-FINDINGS.md) — what was tested in the
  browser, what works, and exactly why `terra` does not load.
- [docs/TERRA-WASM.md](docs/TERRA-WASM.md) — how to build a terra WebAssembly
  binary that does load, and point the plugin at it.
- [docs/OFFLINE.md](docs/OFFLINE.md) — running the in-browser backend without
  internet access.

## Publishing to the GeoLibre catalogue

Add an entry to `plugin-registry.json` in
[opengeos/geolibre-plugins](https://plugins.geolibre.app/develop/):

```json
{
  "id": "movecost",
  "name": "movecost — least-cost analysis",
  "version": "0.1.0",
  "manifestUrl": "https://<host>/plugins/movecost/plugin.json",
  "description": "Least-cost paths, corridors, networks and isochrones with the movecost R package in WebAssembly.",
  "author": "Enzo Cocca",
  "homepage": "https://github.com/enzococca/geolibre-movecost",
  "categories": ["Analysis"],
  "minGeoLibreVersion": "1.0.0"
}
```

## Credits and licence

`movecost` is by **Gianmarco Alberti** — Alberti, G. (2019). *movecost: An R
package for calculating accumulated slope-dependent anisotropic cost-surfaces
and least-cost paths.* SoftwareX 10, 100331.
<https://doi.org/10.1016/j.softx.2019.100331>

R in the browser is [webR](https://docs.r-wasm.org/webr/latest/) by the
R-WASM project. This plugin is GPL-3.0-or-later, matching movecost's licence.
