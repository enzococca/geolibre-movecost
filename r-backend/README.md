# The local R backend

The plugin prefers a small R service running on your own machine. It is the
fast, complete path: real `movecost`, native speed, and DTMs as large as R can
handle.

The plugin probes `http://127.0.0.1:8787/health` when its panel opens. If the
service answers, the panel says *Backend: Local R service*; if not, it falls
back to the in-browser runtime and says so.

## One-time setup

```r
# movecost 3.0.0 changed its entire API (compute-once `mc_*` functions); this
# plugin speaks the 2.x one, which is also what the WebAssembly build carries.
install.packages(c("plumber", "sf", "terra", "raster", "sp", "jsonlite"))
install.packages("remotes"); remotes::install_version("movecost", "2.2")

# Optional, for "draw an area and download a DEM". `progress` is an elevatr
# dependency that is only needed at call time, so install it explicitly.
install.packages(c("elevatr", "progress"))
```

The service reports at startup when the elevation packages are absent;
everything else still works, and you load a GeoTIFF instead.

## Every session

From the plugin project root:

```bash
Rscript r-backend/start.R
```

```
movecost backend listening on http://127.0.0.1:8787
```

Then click **Recheck** in the plugin panel, or reopen it.

Options:

| Variable | Meaning |
| --- | --- |
| `MOVECOST_PORT` | Port to listen on (default `8787`) |
| `MOVECOST_ENGINE` | Path to `movecost-engine.R` if you start from elsewhere |

To point the plugin at a different port, set the override in GeoLibre's devtools
console and reopen the panel:

```js
localStorage.setItem("MOVECOST_BACKEND_URL", "http://127.0.0.1:9000");
```

## What it exposes

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness plus the R and package versions in use |
| `POST /run` | One analysis: multipart `dtm`, `origin`, `destin?`, `barrier?`, `request` |
| `POST /dem` | Elevation for an area: multipart `area` (GeoJSON polygon), `zoom` (1–14). Responds with the GeoTIFF itself; the size, resolution, CRS and elevation range travel in the `X-Movecost-Summary` header so the raster is not base64-inflated. |
| `POST /preview` | A DTM (multipart `dtm`) summarised for display: dimensions, resolution, elevation range, and a downsampled raster payload the plugin paints on the map. |

`POST /run` takes either a `dtm` part or a `studyplot` part. With `studyplot` and
no DTM, movecost downloads elevation for that polygon itself on every call
(its own `studyplot` + `z` arguments) rather than reusing a DTM you already hold.

`POST /run` returns exactly the JSON documented in
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) — the service is a transport
around the same `movecost-engine.R` the in-browser runtime sources.

## Security

The server binds to `127.0.0.1` only, so nothing outside the machine can reach
it. It accepts cross-origin requests because the GeoLibre app is a different
origin, and it writes every upload into a per-request temporary directory that
is deleted when the request finishes. It runs no code from the request: the
`analysis` field is matched against a fixed list inside the engine.

Do not expose it on a public interface.
