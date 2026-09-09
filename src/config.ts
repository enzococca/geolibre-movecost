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

/** Where webR's `R.bin.wasm`, `webr-worker.js` and friends are served from. */
export const WEBR_BASE_URL =
  readOverride("MOVECOST_WEBR_BASE_URL") ?? `https://webr.r-wasm.org/v${WEBR_VERSION}/`;

/**
 * CRAN-for-WebAssembly repository holding movecost and its dependencies.
 * This is the repository ROOT: webR appends `bin/emscripten/contrib/<R version>/`
 * itself, so do not include that path here.
 */
export const WASM_CRAN_REPO =
  readOverride("MOVECOST_WASM_REPO") ?? "https://repo.r-wasm.org";

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
