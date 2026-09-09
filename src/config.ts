/**
 * Build-time configuration for the runtime pieces that cannot be bundled.
 *
 * webR ships R itself as WebAssembly (tens of megabytes) and installs CRAN
 * packages as prebuilt `.tgz` archives, so both are fetched over the network the
 * first time an analysis runs. Point these at a local mirror for offline or
 * air-gapped work — see docs/OFFLINE.md.
 */

/** webR release whose wasm build we load. Must match the `webr` npm dependency. */
export const WEBR_VERSION = "0.6.0";

/**
 * Where webR's `webr-worker.js`, `R.js`, `R.wasm` and the virtual filesystem
 * are served from.
 *
 * The npm package on jsDelivr rather than webR's own CDN, and the reason is
 * GeoLibre's Content-Security-Policy. For a cross-origin base URL webR fetches
 * the worker script itself and starts it from a `blob:` URL, which
 * `worker-src blob: 'self'` allows; inside that worker, `importScripts()` of
 * `R.js` is governed by `script-src`, which lists `https://cdn.jsdelivr.net/npm/`
 * and not `webr.r-wasm.org`. The wasm and package archives arrive through
 * `fetch`, covered by `connect-src https:`. Verified against webR 0.6.0.
 */
export const WEBR_BASE_URL =
  readOverride("MOVECOST_WEBR_BASE_URL") ??
  `https://cdn.jsdelivr.net/npm/webr@${WEBR_VERSION}/dist/`;

/**
 * The upstream CRAN-for-WebAssembly repository. This is the repository ROOT:
 * webR appends `bin/emscripten/contrib/<R version>/` itself, so the path is not
 * part of it.
 */
export const UPSTREAM_WASM_REPO = "https://repo.r-wasm.org";

/**
 * The repository published with the plugin's own site, carrying the rebuilt
 * terra (docs/TERRA-WASM.md). The panel also discovers a `wasm-repo/` next to
 * whichever manifest the plugin was installed from, but a copy installed from
 * the GeoLibre plugin registry is served from plugins.geolibre.app with no
 * repository beside it, so this one is always consulted before upstream.
 */
export const PUBLISHED_WASM_REPO = "https://enzococca.github.io/geolibre-movecost/wasm-repo";

/**
 * Repositories to install from, in order of preference.
 *
 * `MOVECOST_WASM_REPO` prepends a repository rather than replacing the upstream
 * one, which matters: a repository built by `scripts/build-terra-wasm.sh`
 * carries the one or two packages that needed rebuilding, and everything else
 * has to keep coming from upstream. Setting it as the sole repository makes
 * even `jsonlite` unresolvable.
 */
export const WASM_CRAN_REPOS: string[] = (() => {
  const override = readOverride("MOVECOST_WASM_REPO");
  const repos = [PUBLISHED_WASM_REPO, UPSTREAM_WASM_REPO];
  return override ? [override, ...repos] : repos;
})();

/** The repository webR treats as its default; the full list is used on install. */
export const WASM_CRAN_REPO = WASM_CRAN_REPOS[0];

/**
 * Installed in this order. movecost 2.x sits on the raster/sp stack; terra and
 * sf are used by the engine itself for I/O and reprojection.
 */
export const R_PACKAGES = [
  "jsonlite",
  "sp",
  "raster",
  "terra",
  "sf",
  "gdistance",
  "chron",
  "movecost",
] as const;

/** Rough download sizes, only used to make the progress bar honest. */
export const R_PACKAGE_WEIGHTS: Record<string, number> = {
  jsonlite: 1,
  sp: 2,
  raster: 4,
  terra: 8,
  sf: 10,
  gdistance: 2,
  chron: 1,
  movecost: 2,
};

/**
 * Reads an override from `localStorage`, so a site or a tester can repoint the
 * runtime without rebuilding. Wrapped because storage access throws outright in
 * some embedding contexts.
 */
function readOverride(key: string): string | null {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
