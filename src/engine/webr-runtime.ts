import { WebR } from "webr";
import engineSource from "./movecost-engine.R?raw";
import { R_PACKAGES, R_PACKAGE_WEIGHTS, WASM_CRAN_REPOS, WEBR_BASE_URL } from "../config";
import type {
  AnalysisId,
  AnalysisParams,
  DtmPreview,
  EngineInputs,
  EngineRequest,
  EngineResponse,
  ProgressEvent,
} from "./types";
import { parseDemSummary, type AnalysisBackend, type DemResult } from "./backend";
import type { ElevationGrid } from "../map/terrain-tiles";

const WORK_DIR = "/movecost";
const ENGINE_PATH = `${WORK_DIR}/movecost-engine.R`;

export type ProgressListener = (event: ProgressEvent) => void;

/**
 * Owns the single webR instance and serialises analyses through it.
 *
 * Booting is expensive and happens once per session: R itself is ~40 MB of
 * WebAssembly and the movecost dependency stack another ~25 MB, all fetched on
 * first use. Everything after that is local, so a second analysis starts
 * immediately.
 */
export class MovecostEngine implements AnalysisBackend {
  readonly id = "webr" as const;
  /**
   * Where webR's wasm payload is fetched from. GeoLibre Desktop's CSP allows
   * workers only from `blob:` and its own origin, so loading webR straight from
   * its CDN is refused there; shipping webR's `dist/` inside the plugin folder
   * and resolving it through the host's asset URL makes it same-origin and
   * allowed. Falls back to the CDN, which is what the demo page and browser
   * builds use.
   */
  constructor(
    private readonly baseUrl: string = WEBR_BASE_URL,
    /**
     * Repositories consulted before the configured ones — typically the
     * `wasm-repo/` published next to the plugin manifest, carrying the rebuilt
     * terra (see docs/TERRA-WASM.md).
     */
    private readonly extraRepos: string[] = [],
  ) {}

  private get repos(): string[] {
    return [...this.extraRepos, ...WASM_CRAN_REPOS.filter((r) => !this.extraRepos.includes(r))];
  }

  private webR: WebR | null = null;
  private booting: Promise<WebR> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<ProgressListener>();
  private requestCounter = 0;

  versions: Record<string, string> | null = null;

  get label(): string {
    const movecost = this.versions?.movecost;
    return movecost ? `In-browser R (movecost ${movecost})` : "In-browser R (webR)";
  }

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isReady(): boolean {
    return this.webR !== null;
  }

  private emit(phase: ProgressEvent["phase"], message: string, fraction: number | null = null) {
    const event: ProgressEvent = { phase, message, fraction };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken listener must not abort an analysis */
      }
    }
  }

  /** Boots R, installs packages and sources the engine. Safe to call repeatedly. */
  async boot(): Promise<WebR> {
    if (this.webR) return this.webR;
    if (this.booting) return this.booting;

    this.booting = (async () => {
      this.emit("downloading-r", "Downloading the R runtime (about 40 MB, once per session)…", null);

      const webR = new WebR({
        baseUrl: this.baseUrl,
        repoUrl: this.repos[0],
        interactive: false,
      });
      await webR.init();

      const total = R_PACKAGES.reduce((sum, p) => sum + (R_PACKAGE_WEIGHTS[p] ?? 1), 0);
      let done = 0;
      for (const pkg of R_PACKAGES) {
        this.emit(
          "installing-packages",
          `Installing R package ${pkg}…`,
          Math.min(0.99, done / total),
        );
        await installPackage(webR, pkg, this.repos);
        done += R_PACKAGE_WEIGHTS[pkg] ?? 1;
      }

      this.emit("loading-engine", "Loading the movecost engine…", 1);
      await ensureDir(webR, WORK_DIR);
      await webR.FS.writeFile(ENGINE_PATH, new TextEncoder().encode(engineSource));
      await webR.evalRVoid(`source(${rString(ENGINE_PATH)})`);

      const versionsJson = await webR.evalRString(
        "jsonlite::toJSON(mcx_version(), auto_unbox = TRUE)",
      );
      this.versions = JSON.parse(versionsJson) as Record<string, string>;

      this.webR = webR;
      this.emit("done", "The movecost engine is ready.", 1);
      return webR;
    })();

    try {
      return await this.booting;
    } catch (error) {
      this.booting = null;
      this.emit("error", describeError(error));
      throw error;
    }
  }

  /**
   * Runs one analysis. Calls are queued: R is single-threaded, and letting two
   * analyses interleave in the same VFS would have them overwrite each other's
   * inputs.
   */
  run(
    request: { analysis: AnalysisId; params: AnalysisParams },
    inputs: EngineInputs,
  ): Promise<EngineResponse> {
    const task = this.queue.then(
      () => this.runNow(request, inputs),
      () => this.runNow(request, inputs),
    );
    // Keep the chain alive even when a run rejects.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async runNow(
    request: { analysis: AnalysisId; params: AnalysisParams },
    inputs: EngineInputs,
  ): Promise<EngineResponse> {
    const webR = await this.boot();
    const id = ++this.requestCounter;
    const dir = `${WORK_DIR}/run-${id}`;
    await ensureDir(webR, dir);

    const encoder = new TextEncoder();
    const dtmPath = inputs.dtm && !inputs.dtmHandle ? `${dir}/dtm.tif` : null;
    const studyplotPath = inputs.studyplot ? `${dir}/studyplot.geojson` : null;
    const originPath = `${dir}/origin.geojson`;
    const destinPath = inputs.destin ? `${dir}/destin.geojson` : null;
    const barrierPath = inputs.barrier ? `${dir}/barrier.geojson` : null;
    const requestPath = `${dir}/request.json`;
    const responsePath = `${dir}/request.response.json`;

    this.emit("running", "Writing inputs into the R filesystem…", null);
    if (dtmPath) await webR.FS.writeFile(dtmPath, inputs.dtm!);
    if (studyplotPath) {
      await webR.FS.writeFile(studyplotPath, encoder.encode(inputs.studyplot!));
    }
    await webR.FS.writeFile(originPath, encoder.encode(inputs.origin));
    if (destinPath) await webR.FS.writeFile(destinPath, encoder.encode(inputs.destin!));
    if (barrierPath) await webR.FS.writeFile(barrierPath, encoder.encode(inputs.barrier!));

    const fullRequest: EngineRequest = {
      ...request,
      dtmPath,
      dtmHandle: inputs.dtmHandle ?? null,
      studyplotPath,
      originPath,
      destinPath,
      barrierPath,
    };
    await webR.FS.writeFile(requestPath, encoder.encode(JSON.stringify(fullRequest)));

    this.emit(
      "running",
      `Running the ${request.analysis} analysis — this can take a while on a large DTM…`,
      null,
    );
    await webR.evalRVoid(`mcx_run(${rString(requestPath)})`);

    this.emit("reading-results", "Reading the results back…", null);
    const raw = await webR.FS.readFile(responsePath);
    const response = JSON.parse(new TextDecoder().decode(raw)) as EngineResponse;

    await cleanupDir(webR, dir);
    this.emit(response.ok ? "done" : "error", response.ok ? "Analysis complete." : response.error, 1);
    return response;
  }

  /**
   * The in-browser route to terrain for a drawn area: the page fetches the
   * tiles, R turns the grid into a UTM GeoTIFF. Serialised through the queue
   * like an analysis, since it shares the R session.
   */
  dtmFromGrid(
    grid: ElevationGrid,
    areaGeoJson: string | null,
    options: { maxCells?: number } = {},
  ): Promise<DemResult> {
    const task = this.queue.then(
      () => this.gridNow(grid, areaGeoJson, options),
      () => this.gridNow(grid, areaGeoJson, options),
    );
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async gridNow(
    grid: ElevationGrid,
    areaGeoJson: string | null,
    options: { maxCells?: number },
  ): Promise<DemResult> {
    const webR = await this.boot();
    const dir = `${WORK_DIR}/grid-${++this.requestCounter}`;
    await ensureDir(webR, dir);
    const encoder = new TextEncoder();
    const gridPath = `${dir}/grid.bin`;
    const areaPath = areaGeoJson ? `${dir}/area.geojson` : null;
    // The projected DTM stays in R memory under this handle. writeRaster() never
    // returns under webR for anything above a couple of thousand cells, and the
    // analyses do not need a file — they take the handle.
    const handle = `dem-${this.requestCounter}`;
    const requestPath = `${dir}/grid.json`;
    const responsePath = `${dir}/grid.response.json`;

    this.emit("running", "Projecting the elevation grid…", null);
    await webR.FS.writeFile(
      gridPath,
      new Uint8Array(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength),
    );
    if (areaPath) await webR.FS.writeFile(areaPath, encoder.encode(areaGeoJson!));
    await webR.FS.writeFile(
      requestPath,
      encoder.encode(JSON.stringify({
        gridPath, areaPath, keepAs: handle, maxCells: options.maxCells ?? null,
        width: grid.width, height: grid.height, crs: grid.crs, zoom: grid.zoom,
        xmin: grid.xmin, ymin: grid.ymin, xmax: grid.xmax, ymax: grid.ymax,
      })),
    );
    await webR.evalRVoid(`mcx_grid_to_dtm(${rString(requestPath)})`);

    const raw = JSON.parse(
      new TextDecoder().decode(await webR.FS.readFile(responsePath)),
    ) as { ok: boolean; error?: string } & Record<string, unknown>;
    if (!raw.ok) {
      await cleanupDir(webR, dir);
      this.emit("error", raw.error ?? "The grid could not be projected.", 1);
      throw new Error(raw.error ?? "The grid could not be projected.");
    }
    await cleanupDir(webR, dir);
    const summary = parseDemSummary(raw);
    this.emit("done", `Built a ${summary.width} x ${summary.height} DTM.`, 1);
    return { bytes: new Uint8Array(0), handle, summary };
  }

  /** Same preview the HTTP backend serves, computed in the page instead. */
  async previewDtm(dtm: Uint8Array, handle?: string | null): Promise<DtmPreview> {
    const webR = await this.boot();
    const dir = `${WORK_DIR}/preview-${++this.requestCounter}`;
    await ensureDir(webR, dir);
    const dtmPath = handle ? null : `${dir}/dtm.tif`;
    const requestPath = `${dir}/preview.json`;
    const responsePath = `${dir}/preview.response.json`;

    if (dtmPath) await webR.FS.writeFile(dtmPath, dtm);
    await webR.FS.writeFile(
      requestPath,
      new TextEncoder().encode(JSON.stringify({ dtmPath, dtmHandle: handle ?? null })),
    );
    await webR.evalRVoid(`mcx_preview_dtm(${rString(requestPath)})`);
    const raw = await webR.FS.readFile(responsePath);
    const payload = JSON.parse(new TextDecoder().decode(raw)) as
      & { ok: boolean; error?: string }
      & DtmPreview;
    await cleanupDir(webR, dir);
    if (!payload.ok) throw new Error(payload.error ?? "The DTM preview failed.");
    return payload;
  }

  async close(): Promise<void> {
    const webR = this.webR;
    this.webR = null;
    this.booting = null;
    this.versions = null;
    if (webR) {
      try {
        await webR.close();
      } catch {
        /* the worker may already be gone */
      }
    }
  }
}

// --- helpers -----------------------------------------------------------------

/** Quotes a path for R without relying on string interpolation being safe. */
function rString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function ensureDir(webR: WebR, path: string): Promise<void> {
  try {
    await webR.FS.mkdir(path);
  } catch {
    /* already there */
  }
}

async function cleanupDir(webR: WebR, dir: string): Promise<void> {
  // Keeps the emulated filesystem from growing across a long session.
  await webR
    .evalRVoid(`unlink(${rString(dir)}, recursive = TRUE, force = TRUE)`)
    .catch(() => undefined);
}

/**
 * webR changed `installPackages` from `(names, quiet)` to `(names, options)`
 * across releases; try the modern shape first and fall back so the plugin keeps
 * working against whichever build the host has cached.
 */
async function installPackage(webR: WebR, pkg: string, repos: string[]): Promise<void> {
  const install = webR.installPackages.bind(webR) as (
    packages: string[],
    options?: unknown,
  ) => Promise<void>;
  try {
    await install([pkg], { repos, quiet: true });
  } catch (error) {
    try {
      await install([pkg]);
    } catch {
      throw new Error(
        `Could not install the R package "${pkg}". ` +
          `Check that ${repos.join(" and ")} are reachable from GeoLibre. ` +
          `Original error: ${describeError(error)}`,
      );
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
