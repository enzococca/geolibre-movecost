# Verifying the plugin in GeoLibre Desktop

Everything below has been checked except the last section, which needs the
GeoLibre window itself.

## Already verified

| Check | Result |
| --- | --- |
| R engine under native `Rscript`, all six analyses + error handling | ✅ 8/8 |
| Plugin bundle is self-contained (no unresolved imports, exports `plugin` and default) | ✅ 166 kB |
| `plugin.json` / bundle version match, zip layout | ✅ |
| Local R service `GET /health` | ✅ R 4.6.0, movecost 2.2 |
| Local R service `POST /run`, all six analyses, from a browser | ✅ 0.5 s – 7.5 s |
| `POST /dem` — DEM download for a drawn area (Vesuvius, 10 × 8 km, zoom 11) | ✅ 297 × 274 at 28.6 m, 20–1254 m, 6.6 s |
| Least-cost path on that downloaded DEM | ✅ 2.4 s, 02:09:29 walking time |
| `POST /run` with `studyplot` and no DTM (movecost's own download path) | ✅ 4.2 s, 02:09:06 — agrees with the pre-downloaded DEM |
| `POST /preview` and the terrain overlay payload | ✅ 0.08 s, Float32 length exact |
| `fetchDem` / `previewDtm` / studyplot run through the TypeScript backend | ✅ |
| Raster payload decodes as Float32 and paints on a canvas | ✅ |
| GeoLibre Desktop CSP allows `http://127.0.0.1:*` in `connect-src` | ✅ |
| In-browser webR backend | ❌ blocked upstream — see docs/WEBR-FINDINGS.md |

## What you need to check in GeoLibre

The plugin is already installed at

```
~/Library/Application Support/org.geolibre.desktop/plugins/movecost
```

1. **Start the R service** (leave it running):

   ```bash
   cd ~/geolibre-movecost
   Rscript r-backend/start.R
   ```

2. **Restart GeoLibre Desktop**, open *Manage Plugins*, and enable
   **movecost — least-cost analysis**.

3. Open the panel — the button is in the map's top-right corner, or the
   *movecost* toolbar menu. The header should read
   **Backend: Local R service (movecost 2.2)**. If it says *In-browser R*, the
   service is not running or is on another port; start it and press **Recheck**.

4. **Get a DTM.** Leave the first option selected (*Draw an area and download a
   DEM*), draw a polygon over your study area with GeoLibre's draw tools, press
   *Use drawn polygon*, and then *Download DEM*. *Use current view* works too if
   you would rather frame the area by panning. Detail level 11–12 is a good
   start. *Use area directly* is the alternative: no download step, but movecost
   fetches elevation inside every run. Or switch to *Load a GeoTIFF from disk* —
   `examples/public/dtm.tif` is a synthetic 120 × 120 test grid in UTM 33N if
   you want something known-good first.

   The terrain should appear on the map straight away, with a *Hide terrain*
   button and the elevation range beside it. If it does not, that is the same
   `getMap()` question as the raster results below — the analysis is unaffected.

5. **Place the points.** With the test DTM, click twice inside the raster —
   once for the origin, once for the destination. Click *Click on the map*,
   place the point, then *Stop placing*.

6. **Run** with the default Tobler on-path function. You should get, as normal
   GeoLibre layers: `movecost — Least-cost paths`, `movecost — Cost isolines`,
   `movecost — Destinations with cost`; plus two raster overlays (accumulated
   cost, cost surface) listed in the panel.

### The two things most likely to be wrong

- **Raster overlays.** They are added through `app.getMap()` as MapLibre image
  sources, because the host has no "add raster from an array" helper. If they do
  not appear, check whether `getMap()` returns null in this build — vector
  results are unaffected either way, and the panel will say so.
- **Panel docking.** The panel registers with `dock: "replace-style"`. If it
  lands somewhere awkward, change that one line in `src/index.ts`
  (`left-of-layers`, `right-of-layers`, `left-of-style`, `right-of-style`,
  `replace-layers` are the alternatives) and rerun `npm run install:geolibre`.

### After changing anything

```bash
cd ~/geolibre-movecost
npm run install:geolibre     # rebuilds and reinstalls
```

then restart GeoLibre.
