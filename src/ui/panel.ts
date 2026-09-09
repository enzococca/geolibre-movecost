import { COST_FUNCTIONS, costUnitLabel, getCostFunction, isTimeFunction } from "../engine/cost-functions";
import type { AnalysisId, AnalysisParams, EngineResponse, ProgressEvent, RasterPayload } from "../engine/types";
import { MovecostEngine, describeError } from "../engine/webr-runtime";
import {
  DEFAULT_BACKEND_URL,
  HttpBackend,
  isMobileDevice,
  probeBackend,
  type AnalysisBackend,
  type DemSummary,
} from "../engine/backend";
import type { DtmPreview } from "../engine/types";
import { estimateGrid, fetchTerrariumGrid, zoomWithinBudget } from "../map/terrain-tiles";
import {
  COLOUR_RAMPS,
  decodeRaster,
  getRamp,
  renderLegend,
  renderRasterThumbnail,
} from "../map/raster-overlay";
import {
  addHostRasterLayer,
  addHostVectorLayer,
  addRawMarkerLayer,
  groupHostLayers,
  hostOwnsLayers,
  type HostLayerHandle,
} from "../map/host-layers";
import { DESTINATION_STYLE, ORIGIN_STYLE, resultStyle } from "../map/styles";
import {
  boundsOf,
  emptyPointSet,
  keepLinesAndPolygons,
  keepPoints,
  keepPolygons,
  listVectorLayers,
  makePointFeature,
  pointsToGeoJson,
  readDrawings,
  readLayer,
  readSelection,
  startPointPicking,
  toFeatureCollection,
  unionBounds,
  viewportPolygon,
  type PointSet,
} from "../map/points";
import type { GeoJsonFeature, GeoLibreAppAPI } from "../types/geolibre";
import { ANALYSES, getAnalysis, type ExtraField } from "./analyses";
import {
  button,
  checkbox,
  clear,
  el,
  field,
  formatBytes,
  note,
  numberInput,
  select,
  textInput,
} from "./dom";

interface DtmFile {
  name: string;
  bytes: Uint8Array;
  /** Set when the backend keeps the DTM in its R session instead of `bytes`. */
  handle?: string;
  /** Present when the DEM was downloaded rather than picked from disk. */
  summary?: DemSummary;
}

/**
 * elevatr's AWS terrain tiles. The metre figures are ground resolution at the
 * equator, which is what makes the trade-off legible: a finer zoom is a better
 * DTM and a much slower analysis, since cost-distance work grows with the cell
 * count.
 */
const DEM_ZOOMS = [
  { value: "9", label: "9 — about 300 m/cell (regional)" },
  { value: "10", label: "10 — about 150 m/cell" },
  { value: "11", label: "11 — about 75 m/cell" },
  { value: "12", label: "12 — about 38 m/cell (default)" },
  { value: "13", label: "13 — about 19 m/cell" },
  { value: "14", label: "14 — about 10 m/cell (slow over a large area)" },
];

interface ProducedLayer {
  label: string;
  kind: "raster" | "vector";
  /** Null when the host gave us no way to draw it; the preview then stands in. */
  handle: HostLayerHandle | null;
  /** Thumbnail and value range, kept for every raster result. */
  preview?: { canvas: HTMLCanvasElement; min: number; max: number };
}

/** Fixed store ids: the marker layers are refreshed in place, never duplicated. */
const ORIGIN_LAYER_ID = "movecost-origin";
const DESTINATION_LAYER_ID = "movecost-destination";
const TERRAIN_LAYER_ID = "movecost-terrain";
const INPUT_GROUP_NAME = "movecost · input";

const DEFAULT_PARAMS: AnalysisParams = {
  funct: "t",
  time: "h",
  move: 16,
  field: 0,
  cognSlope: false,
  topoDist: false,
  slCrit: 10,
  W: 70,
  L: 0,
  N: 1,
  V: 1.2,
  irregularDtm: false,
  autoReproject: true,
  netwType: "allpairs",
  lcpN: 3,
};

/**
 * R's out-of-memory messages ("cannot allocate vector of size 150 Mb",
 * "memory exhausted") say nothing about what to do; the fix is always the same.
 */
function withMemoryHint(message: string, where: string): string {
  if (!/cannot allocate|memory exhausted|out of memory|not enough memory|Cannot enlarge memory/i.test(message)) {
    return message;
  }
  return (
    `${message} — ${where} ran out of memory. Use a coarser detail level or a smaller area ` +
    `(fewer DEM cells), or 8 movement directions instead of 16.`
  );
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  return abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2);
}

/**
 * The plugin's right-side workspace panel.
 *
 * All state lives here rather than in the DOM, and `render()` rebuilds the body
 * from it. The panel is small enough that a full rebuild is cheaper than
 * tracking individual nodes, and it keeps the "which controls apply to this
 * analysis and this cost function" logic in one place.
 */
export class MovecostPanel {
  private container: HTMLElement | null = null;
  /**
   * Resolved on first use: a local R service when one answers on the loopback
   * port, otherwise webR in the page. The distinction matters enough to the
   * user — speed, size limits, and today the in-browser path cannot load terra
   * at all — that the panel says which one is in use.
   */
  private backend: AnalysisBackend | null = null;
  private backendProbe: Promise<AnalysisBackend> | null = null;
  private backendNote: string | null = null;
  private disposeProgress: (() => void) | null = null;

  private dtm: DtmFile | null = null;
  private analysis: AnalysisId = "paths";
  private params: AnalysisParams = { ...DEFAULT_PARAMS };
  private extras: Record<string, unknown> = {};

  /** "download" is offered first: most users have an area in mind, not a file. */
  private terrainMode: "download" | "upload" = "download";
  private area: { features: GeoJsonFeature[]; label: string } | null = null;
  private demZoom = 12;
  private downloadingDem = false;
  /**
   * True when the area is handed to movecost as its `studyplot` instead of
   * being downloaded first. movecost then fetches elevation inside every call —
   * fine for one run, wasteful once you start comparing cost functions.
   */
  private useArea = false;
  private terrainOverlay: HostLayerHandle | null = null;
  private terrainPreview: DtmPreview | null = null;
  private terrainVisible = true;

  private origin: PointSet = emptyPointSet();
  private destination: PointSet = emptyPointSet();
  private barrier: PointSet = emptyPointSet();

  private picking: "origin" | "destination" | null = null;
  private stopPicking: (() => void) | null = null;

  /** Live marker layers for the chosen origins / destinations. */
  private markers: { origin: HostLayerHandle | null; destination: HostLayerHandle | null } = {
    origin: null,
    destination: null,
  };
  /** Raw-map fallback markers, when the host cannot register layers. */
  private rawMarkerCleanup: { origin: (() => void) | null; destination: (() => void) | null } = {
    origin: null,
    destination: null,
  };
  /** Layers-panel group holding the terrain and the markers. */
  private inputGroupId: string | null = null;
  private runCount = 0;

  private rampId = "viridis";
  private rasterOpacity = 0.75;

  private busy = false;
  private progress: ProgressEvent | null = null;
  private message: { text: string; tone: "info" | "warn" | "error" } | null = null;
  private lastRun: { response: EngineResponse; layers: ProducedLayer[] } | null = null;
  private produced: ProducedLayer[] = [];

  constructor(private readonly app: GeoLibreAppAPI) {
    // On a tablet R runs inside the browser with a hard memory ceiling, and
    // 16 directions double the transition matrix over 8 for a marginal gain.
    if (isMobileDevice()) this.params.move = 8;
    void this.resolveBackend();
  }

  /**
   * How many DTM cells an analysis can take here.
   *
   * movecost builds a sparse transition matrix with one entry per cell and
   * direction, and gdistance copies it several times; inside webR the whole
   * thing must fit in the WebAssembly heap, which on an iPad is a few hundred
   * megabytes before Safari kills the page. The figures are what stayed under
   * that on GeoLibre 2.9.0: 150k cells (about 390 x 390) on a tablet, 400k on
   * a desktop browser. The local R service has the machine's memory.
   */
  private cellBudget(): { cells: number; where: string } {
    const inBrowser = !this.backend || this.backend.id === "webr";
    if (!inBrowser) return { cells: 4_000_000, where: "the local R service" };
    return isMobileDevice()
      ? { cells: 150_000, where: "R inside the browser on a tablet" }
      : { cells: 400_000, where: "R inside the browser" };
  }

  /** The grid the tile download would produce for the current area and detail. */
  private plannedGrid() {
    if (!this.area) return null;
    const budget = this.cellBudget();
    // Terrarium tiles are 256 px where elevatr's are 512 px, so the tile zoom
    // is one finer than the level the menu names.
    const requested = Math.min(15, this.demZoom + 1);
    const wanted = estimateGrid(this.area.features, requested);
    const fits = zoomWithinBudget(this.area.features, requested, budget.cells);
    if (!wanted || !fits) return null;
    return { budget, wanted, fits, reduced: fits.zoom < requested, overBudget: fits.cells > budget.cells };
  }

  /**
   * A copy of webR shipped alongside the plugin manifest takes precedence over
   * the CDN default. Returns undefined — and so the default — when none is.
   */
  private webrBaseUrl(): string | undefined {
    return this.pluginAsset("webr/") ?? undefined;
  }

  /**
   * The repository published next to the manifest, when there is one. That is
   * where the rebuilt terra lives (docs/TERRA-WASM.md): the plugin site puts it
   * at `wasm-repo/`, so a manifest-URL install finds it with no configuration.
   */
  private pluginRepos(): string[] {
    const repo = this.pluginAsset("wasm-repo");
    return repo ? [repo.replace(/\/$/, "")] : [];
  }

  private pluginAsset(relativePath: string): string | null {
    try {
      return this.app.resolvePluginAssetUrl?.("movecost", relativePath) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Picks the backend once and remembers it. Re-running the probe is cheap, so
   * the panel offers a button for it: users routinely start the R service after
   * opening GeoLibre.
   */
  private resolveBackend(force = false): Promise<AnalysisBackend> {
    if (force) {
      this.disposeProgress?.();
      this.disposeProgress = null;
      void this.backend?.close();
      this.backend = null;
      this.backendProbe = null;
      // A handle names a raster inside the old backend's R session.
      if (this.dtm?.handle) {
        this.dtm = null;
        this.clearTerrainOverlay();
      }
    }
    if (this.backend) return Promise.resolve(this.backend);
    if (this.backendProbe) return this.backendProbe;

    this.backendProbe = (async () => {
      const health = await probeBackend(DEFAULT_BACKEND_URL);
      const backend: AnalysisBackend = health
        ? new HttpBackend(DEFAULT_BACKEND_URL, health.versions ?? null)
        : new MovecostEngine(this.webrBaseUrl(), this.pluginRepos());
      this.backendNote = health
        ? null
        : isMobileDevice()
          ? `R runs in the page on this device. The first run downloads about 65 MB and takes a ` +
            `few minutes; after that, a small study area answers in seconds. Keep the area modest.`
          : `No local R service on ${DEFAULT_BACKEND_URL}, so R runs in the page. That works, ` +
            `but it is roughly a hundred times slower. The first run fetches about 65 MB. For ` +
            `real work, start the R service (r-backend/README.md) and press Recheck.`;
      this.disposeProgress = backend.onProgress((event) => {
        this.progress = event.phase === "done" || event.phase === "error" ? null : event;
        this.renderStatus();
      });
      this.backend = backend;
      this.render();
      return backend;
    })();

    return this.backendProbe;
  }

  mount(container: HTMLElement): () => void {
    this.container = container;
    container.classList.add("mcx-panel");
    this.render();
    return () => this.unmount();
  }

  private unmount(): void {
    this.cancelPicking();
    this.container = null;
  }

  /**
   * Deactivation removes what only makes sense while the panel is open — the
   * click-to-place markers. The terrain and the results are ordinary GeoLibre
   * layers the user may well want to keep, so they stay; the Layers panel
   * removes them like any other layer.
   */
  dispose(): void {
    this.cancelPicking();
    this.clearMarkers();
    this.disposeProgress?.();
    void this.backend?.close();
  }

  // --- rendering -------------------------------------------------------------

  private render(): void {
    const root = this.container;
    if (!root) return;
    clear(root);

    root.append(
      this.renderIntro(),
      this.renderDtmSection(),
      this.renderAnalysisSection(),
      this.renderLocationsSection(),
      this.renderCostSection(),
      this.renderDisplaySection(),
      this.renderRunSection(),
      this.renderResultsSection(),
    );
  }

  private statusHost: HTMLElement | null = null;

  private renderStatus(): void {
    if (!this.statusHost) return;
    clear(this.statusHost);
    if (this.progress) {
      const bar = el("div", { class: "mcx-progress" });
      const fill = el("div", { class: "mcx-progress__fill" });
      if (this.progress.fraction === null) {
        fill.classList.add("mcx-progress__fill--indeterminate");
      } else {
        fill.style.width = `${Math.round(this.progress.fraction * 100)}%`;
      }
      bar.append(fill);
      this.statusHost.append(el("p", { class: "mcx-status", text: this.progress.message }), bar);
    }
    if (this.message) {
      this.statusHost.append(note(this.message.text, this.message.tone));
    }
  }

  private renderIntro(): HTMLElement {
    const backend = this.backend;
    const versions = backend?.versions ?? null;
    return el(
      "section",
      { class: "mcx-section mcx-section--intro" },
      el("p", {
        class: "mcx-intro",
        text: "Slope-dependent cost analysis with the movecost R package.",
      }),
      el(
        "div",
        { class: "mcx-actions" },
        el("span", {
          class: "mcx-versions",
          text: backend ? `Backend: ${backend.label}` : "Looking for a backend…",
        }),
        button("Recheck", () => void this.resolveBackend(true), "ghost"),
      ),
      versions
        ? el("p", {
            class: "mcx-versions",
            text: [
              versions.r && `R ${versions.r}`,
              versions.terra && `terra ${versions.terra}`,
              versions.sf && `sf ${versions.sf}`,
            ]
              .filter(Boolean)
              .join(" · "),
          })
        : null,
      this.backendNote ? note(this.backendNote, "warn") : null,
    );
  }

  private renderDtmSection(): HTMLElement {
    const children: HTMLElement[] = [
      el("h3", { class: "mcx-section__title", text: "1 · Terrain" }),
      field(
        "Where the DTM comes from",
        select(
          [
            { value: "download", label: "Draw an area and download a DEM" },
            { value: "upload", label: "Load a GeoTIFF from disk" },
          ],
          this.terrainMode,
          (value) => {
            this.terrainMode = value as "download" | "upload";
            this.render();
          },
        ),
      ),
    ];

    children.push(
      ...(this.terrainMode === "download" ? this.renderDemDownload() : this.renderDtmUpload()),
    );

    if (this.dtm) {
      const s = this.dtm.summary;
      children.push(
        el("p", {
          class: "mcx-file-summary",
          text: s
            ? `${this.dtm.name} — ${s.width} × ${s.height} cells at ${s.resolution.toFixed(1)} m, ` +
              `${Math.round(s.elevation.min ?? 0)}–${Math.round(s.elevation.max ?? 0)} m, ${s.crs}`
            : this.dtm.handle
              ? `${this.dtm.name} — held in the R session`
              : `${this.dtm.name} — ${formatBytes(this.dtm.bytes.byteLength)}`,
        }),
      );
    }

    const toggle = this.renderTerrainToggle();
    if (toggle) children.push(toggle);

    children.push(
      checkbox(
        "Reproject a geographic DTM automatically",
        this.params.autoReproject !== false,
        (checked) => {
          this.params.autoReproject = checked;
        },
      ),
      checkbox(
        "DTM has an irregular outline",
        this.params.irregularDtm === true,
        (checked) => {
          this.params.irregularDtm = checked;
        },
        "Tick this when the DTM is a clipped shape with NoData around it.",
      ),
    );

    return el("section", { class: "mcx-section" }, ...children);
  }

  /** Draw-an-area flow: pick a polygon, choose a zoom, fetch the elevation. */
  private renderDemDownload(): HTMLElement[] {
    // Two ways to get elevation for an area: the R service asks elevatr, or the
    // page fetches the tiles itself and hands R the grid. Either is enough.
    const viaService = typeof this.backend?.fetchDem === "function";
    const viaTiles = typeof this.backend?.dtmFromGrid === "function";
    const children: HTMLElement[] = [];

    if (this.backend && !viaService && !viaTiles) {
      children.push(
        note("This backend cannot fetch elevation. Switch to \"Load a GeoTIFF from disk\" above.", "warn"),
      );
      return children;
    }

    const actions = el("div", { class: "mcx-actions" });
    if (this.app.getDrawnFeatures) {
      actions.append(
        button("Use drawn polygon", () => {
          const polygons = keepPolygons(readDrawings(this.app));
          if (!polygons.length) {
            this.message = {
              text: "No polygon found. Draw one with GeoLibre's draw tools, then press this again.",
              tone: "warn",
            };
          } else {
            this.area = { features: polygons.slice(0, 1), label: "drawn polygon" };
            this.message = null;
          }
          this.render();
        }, "primary"),
      );
    }
    if (this.app.getViewBounds) {
      actions.append(
        button("Use current view", () => {
          const view = viewportPolygon(this.app);
          if (!view) {
            this.message = { text: "This build does not report the map's view bounds.", tone: "warn" };
          } else {
            this.area = { features: [view.feature], label: "current map view" };
            this.message = null;
          }
          this.render();
        }),
      );
    }
    if (this.area) {
      actions.append(
        button("Clear area", () => {
          this.area = null;
          this.render();
        }, "ghost"),
      );
    }
    children.push(actions);

    children.push(
      el("p", {
        class: this.area ? "mcx-summary" : "mcx-summary mcx-summary--empty",
        text: this.area
          ? `Area taken from the ${this.area.label}.`
          : "Draw a polygon over the study area, or use the current map view.",
      }),
      field(
        "Detail",
        select(DEM_ZOOMS, String(this.demZoom), (value) => {
          this.demZoom = Number(value);
          this.render();
        }),
        {
          hint: "Elevation comes from the AWS terrain tiles. Finer detail means a much slower analysis.",
        },
      ),
    );

    // Say up front what the download will produce, and whether it has to be
    // coarsened to fit in memory — better than an R "cannot allocate" later.
    const plan = viaTiles && !viaService ? this.plannedGrid() : null;
    if (plan) {
      const { budget, wanted, fits } = plan;
      const cellsText = (g: { width: number; height: number; cells: number; resolution: number }) =>
        `${g.width} × ${g.height} cells (${g.cells.toLocaleString()}) at about ${Math.round(g.resolution)} m`;
      if (plan.overBudget) {
        children.push(
          note(
            `Even the coarsest level gives ${cellsText(fits)}, above the ${budget.cells.toLocaleString()}-cell ` +
              `limit for ${budget.where}. Draw a smaller area.`,
            "error",
          ),
        );
      } else if (plan.reduced) {
        children.push(
          note(
            `${cellsText(wanted)} would not fit ${budget.where} (limit ${budget.cells.toLocaleString()} cells). ` +
              `The download will use level ${fits.zoom - 1} instead: ${cellsText(fits)}. ` +
              `Draw a smaller area for finer detail.`,
            "warn",
          ),
        );
      } else {
        children.push(el("p", { class: "mcx-summary", text: `Expected DEM: ${cellsText(wanted)}.` }));
      }
    } else if (viaService && this.area) {
      const wanted = estimateGrid(this.area.features, this.demZoom);
      if (wanted && wanted.cells > 2_000_000) {
        children.push(
          note(
            `About ${wanted.cells.toLocaleString()} cells at this level — the analysis will take minutes. ` +
              `A coarser level or a smaller area keeps it interactive.`,
            "warn",
          ),
        );
      }
    }

    const download = button(
      this.downloadingDem ? "Downloading…" : "Download DEM",
      () => void this.downloadDem(),
      "primary",
    );
    download.disabled = this.downloadingDem || !this.area;

    const direct = viaService ? button(
      this.useArea ? "Downloading per run ✓" : "Use area directly",
      () => {
        this.useArea = !this.useArea;
        if (this.useArea) {
          this.dtm = null;
          this.clearTerrainOverlay();
        }
        this.render();
      },
      this.useArea ? "primary" : "secondary",
    ) : null;
    if (direct) {
      direct.disabled = !this.area;
      direct.title =
        "Hand the area to movecost as its studyplot. It downloads elevation inside " +
        "every run, so this is quicker for one analysis and slower for several.";
    }

    children.push(el("div", { class: "mcx-actions" }, download, direct));
    if (!viaService && viaTiles) {
      children.push(
        el("p", {
          class: "mcx-description",
          text: "Elevation is fetched tile by tile from the AWS terrain dataset and projected in the page.",
        }),
      );
    }

    if (this.useArea) {
      children.push(
        note(
          "movecost will download elevation on every run. Good for a single analysis; " +
            "download the DEM once if you plan to compare cost functions.",
          "info",
        ),
      );
    }

    return children;
  }

  /** Show/hide control for the terrain layer, once a DTM has been previewed. */
  private renderTerrainToggle(): HTMLElement | null {
    if (!this.terrainOverlay) return null;
    const preview = this.terrainPreview;
    return el(
      "div",
      { class: "mcx-actions" },
      button(
        this.terrainVisible ? "Hide terrain" : "Show terrain",
        () => {
          this.terrainVisible = !this.terrainVisible;
          this.terrainOverlay?.setVisible(this.terrainVisible);
          if (this.terrainVisible) this.groupInputs();
          this.render();
        },
        "ghost",
      ),
      preview
        ? el("span", {
            class: "mcx-versions",
            text: `${Math.round(preview.elevation.min ?? 0)}–${Math.round(preview.elevation.max ?? 0)} m`,
          })
        : null,
    );
  }

  private renderDtmUpload(): HTMLElement[] {
    const input = el("input", {
      class: "mcx-file",
      type: "file",
      accept: ".tif,.tiff,.TIF,.TIFF",
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void this.loadDtm(file);
    });

    return [
      field("Digital terrain model (GeoTIFF)", input, {
        hint: "A projected DTM in metres works best. A geographic DTM is reprojected to its own UTM zone automatically.",
      }),
    ];
  }

  private async downloadDem(): Promise<void> {
    if (!this.area) return;
    const backend = await this.resolveBackend();
    const viaService = typeof backend.fetchDem === "function";
    const viaTiles = typeof backend.dtmFromGrid === "function";
    if (!viaService && !viaTiles) {
      this.message = { text: "This backend cannot fetch elevation.", tone: "warn" };
      this.render();
      return;
    }

    this.downloadingDem = true;
    this.message = null;
    this.render();

    try {
      const areaGeoJson = JSON.stringify(toFeatureCollection(this.area.features));
      let result;
      if (viaService) {
        result = await backend.fetchDem!(areaGeoJson, this.demZoom);
      } else {
        // Terrarium tiles are 256 px where elevatr's GeoTIFF tiles are 512 px,
        // so one zoom level finer gives the cell size the menu promises — unless
        // that grid would not fit in memory, in which case the finest level
        // that does is used and the panel says so.
        const plan = this.plannedGrid();
        if (plan?.overBudget) {
          throw new Error(
            `The area is too large for ${plan.budget.where}: even at the coarsest level it needs ` +
              `${plan.fits.cells.toLocaleString()} cells (limit ${plan.budget.cells.toLocaleString()}). Draw a smaller area.`,
          );
        }
        const tileZoom = plan?.fits.zoom ?? Math.min(15, this.demZoom + 1);
        const reducedTo = plan?.reduced ? tileZoom - 1 : null;
        const grid = await fetchTerrariumGrid(this.area.features, tileZoom, (done, total) => {
          this.progress = {
            phase: "running",
            message: `Fetching elevation tiles… ${done}/${total}`,
            fraction: total ? done / total : null,
          };
          this.renderStatus();
        });
        result = await backend.dtmFromGrid!(grid, areaGeoJson, { maxCells: this.cellBudget().cells });
        result.summary.zoom = reducedTo ?? this.demZoom;
        if (reducedTo !== null) {
          this.message = {
            text:
              `Detail reduced to level ${reducedTo} (about ${Math.round(result.summary.resolution)} m) so the ` +
              `${result.summary.width} × ${result.summary.height} DEM fits ${this.cellBudget().where}. ` +
              `Draw a smaller area for finer detail.`,
            tone: "info",
          };
        }
      }
      const { bytes, summary, handle } = result;
      this.dtm = { name: `DEM (zoom ${summary.zoom})`, bytes, handle, summary };
      this.useArea = false;
      const cells = summary.width * summary.height;
      if (cells > this.cellBudget().cells) {
        this.message = {
          text:
            `That is ${cells.toLocaleString()} cells. Cost-distance work grows with the cell ` +
            `count — consider a coarser detail level or a smaller area if the analysis drags or runs out of memory.`,
          tone: "warn",
        };
      } else if (!this.message) {
        this.message = null;
      }
      const b = summary.bounds;
      this.app.fitBounds?.([b.west, b.south, b.east, b.north]);
      this.downloadingDem = false;
      await this.showTerrain();
      return;
    } catch (error) {
      this.message = { text: `DEM download failed: ${describeError(error)}`, tone: "error" };
    } finally {
      this.downloadingDem = false;
      this.render();
    }
  }

  private renderAnalysisSection(): HTMLElement {
    const spec = getAnalysis(this.analysis);
    return el(
      "section",
      { class: "mcx-section" },
      el("h3", { class: "mcx-section__title", text: "2 · Analysis" }),
      field(
        "Analysis",
        select(
          ANALYSES.map((a) => ({ value: a.id, label: a.label })),
          this.analysis,
          (value) => {
            this.analysis = value as AnalysisId;
            this.extras = {};
            // Point sets carry over, trimmed to what the new analysis accepts,
            // and the marker layers are renamed to its labels.
            const next = getAnalysis(this.analysis);
            if (next.origin.max && this.origin.features.length > next.origin.max) {
              this.origin = { ...this.origin, features: this.origin.features.slice(0, next.origin.max) };
            }
            if (!next.destination) {
              this.destination = emptyPointSet();
            } else if (next.destination.max && this.destination.features.length > next.destination.max) {
              this.destination = {
                ...this.destination,
                features: this.destination.features.slice(0, next.destination.max),
              };
            }
            this.refreshMarkers("origin");
            this.refreshMarkers("destination");
            this.render();
          },
        ),
      ),
      el("p", { class: "mcx-description", text: spec.description }),
      el("p", { class: "mcx-rfunc", text: `movecost function: ${spec.rFunction}` }),
    );
  }

  private renderLocationsSection(): HTMLElement {
    const spec = getAnalysis(this.analysis);
    const children: HTMLElement[] = [
      el("h3", { class: "mcx-section__title", text: "3 · Locations" }),
      this.renderPointPicker("origin", spec.origin.label, spec.origin.min, spec.origin.max),
    ];

    if (spec.destination) {
      children.push(
        this.renderPointPicker(
          "destination",
          spec.destination.label,
          spec.destination.min,
          spec.destination.max,
        ),
      );
    }

    if (spec.supportsBarrier) {
      children.push(this.renderBarrierPicker());
    }

    return el("section", { class: "mcx-section" }, ...children);
  }

  private renderPointPicker(
    which: "origin" | "destination",
    label: string,
    min: number,
    max?: number,
  ): HTMLElement {
    const set = which === "origin" ? this.origin : this.destination;
    const canPick = Boolean(this.app.getMap?.());
    const layers = this.candidateLayers();

    const actions = el("div", { class: "mcx-actions" });

    if (canPick) {
      const active = this.picking === which;
      actions.append(
        button(
          active ? "Stop placing" : "Click on the map",
          () => (active ? this.cancelPicking() : this.startPicking(which)),
          active ? "danger" : "primary",
        ),
      );
    }

    if (this.app.getSelectedFeatures) {
      actions.append(
        button("Use selection", () => {
          const points = keepPoints(readSelection(this.app));
          this.setPoints(which, { kind: "selection", label: "map selection", features: points }, min, max);
        }),
      );
    }

    if (this.app.getDrawnFeatures) {
      actions.append(
        button("Use drawings", () => {
          const points = keepPoints(readDrawings(this.app));
          this.setPoints(which, { kind: "drawings", label: "drawn features", features: points }, min, max);
        }),
      );
    }

    if (set.features.length) {
      actions.append(button("Clear", () => this.setPoints(which, emptyPointSet(), min, max), "ghost"));
    }

    const summary = set.features.length
      ? `${set.features.length} point${set.features.length === 1 ? "" : "s"} from ${set.label}`
      : `No ${label.toLowerCase()} yet — need ${min}${max && max !== min ? ` to ${max}` : max === min ? "" : " or more"}.`;

    const children: HTMLElement[] = [
      el("h4", { class: "mcx-subtitle", text: label }),
      actions,
      el("p", {
        class: set.features.length ? "mcx-summary" : "mcx-summary mcx-summary--empty",
        text: summary,
      }),
    ];

    if (layers.length && this.app.getLayerFeatures) {
      const options = [{ value: "", label: "From an existing layer…" }].concat(
        layers.map((layer) => ({ value: layer.id, label: layer.name ?? layer.id })),
      );
      children.push(
        select(options, "", (layerId) => {
          if (!layerId) return;
          const layer = layers.find((l) => l.id === layerId);
          const points = keepPoints(readLayer(this.app, layerId));
          this.setPoints(
            which,
            { kind: "layer", label: layer?.name ?? layerId, features: points },
            min,
            max,
          );
        }),
      );
    }

    return el("div", { class: "mcx-picker" }, ...children);
  }

  private renderBarrierPicker(): HTMLElement {
    const layers = this.candidateLayers();
    const children: HTMLElement[] = [
      el("h4", { class: "mcx-subtitle", text: "Barriers (optional)" }),
      el("p", {
        class: "mcx-description",
        text: "Lines or polygons that movement cannot cross — a river, a cliff line, a wall.",
      }),
    ];

    const actions = el("div", { class: "mcx-actions" });
    if (this.app.getDrawnFeatures) {
      actions.append(
        button("Use drawings", () => {
          const features = keepLinesAndPolygons(readDrawings(this.app));
          this.barrier = { kind: "drawings", label: "drawn features", features };
          this.render();
        }),
      );
    }
    if (this.barrier.features.length) {
      actions.append(
        button(
          "Clear",
          () => {
            this.barrier = emptyPointSet();
            this.render();
          },
          "ghost",
        ),
      );
    }
    children.push(actions);

    if (layers.length && this.app.getLayerFeatures) {
      const options = [{ value: "", label: "From an existing layer…" }].concat(
        layers.map((layer) => ({ value: layer.id, label: layer.name ?? layer.id })),
      );
      children.push(
        select(options, "", (layerId) => {
          if (!layerId) return;
          const layer = layers.find((l) => l.id === layerId);
          this.barrier = {
            kind: "layer",
            label: layer?.name ?? layerId,
            features: keepLinesAndPolygons(readLayer(this.app, layerId)),
          };
          this.render();
        }),
      );
    }

    if (this.barrier.features.length) {
      children.push(
        el("p", {
          class: "mcx-summary",
          text: `${this.barrier.features.length} barrier feature(s) from ${this.barrier.label}`,
        }),
        field(
          "Conductance across barriers",
          numberInput(this.params.field ?? 0, (value) => {
            this.params.field = value;
          }, { step: 0.1 }),
          { hint: "0 makes barriers impassable; a small positive value makes them merely expensive." },
        ),
      );
    }

    return el("div", { class: "mcx-picker" }, ...children);
  }

  private renderCostSection(): HTMLElement {
    const fn = getCostFunction(this.params.funct);
    const children: HTMLElement[] = [
      el("h3", { class: "mcx-section__title", text: "4 · Cost function" }),
      field(
        "Function",
        select(
          COST_FUNCTIONS.map((f) => ({ value: f.id, label: f.label, group: f.group })),
          this.params.funct,
          (value) => {
            this.params.funct = value;
            this.render();
          },
        ),
      ),
      el("p", {
        class: "mcx-description",
        text: `Cost is expressed in ${costUnitLabel(this.params.funct, this.params.time ?? "h")}.`,
      }),
    ];

    if (isTimeFunction(this.params.funct)) {
      children.push(
        field(
          "Time unit",
          select(
            [
              { value: "h", label: "Hours" },
              { value: "m", label: "Minutes" },
            ],
            this.params.time ?? "h",
            (value) => {
              this.params.time = value as "h" | "m";
              this.render();
            },
          ),
          { inline: true },
        ),
      );
    }

    if (fn.uses.includes("W")) {
      children.push(
        field("Body weight (kg)", numberInput(this.params.W ?? 70, (v) => (this.params.W = v), { min: 20, max: 250, step: 1 }), { inline: true }),
      );
    }
    if (fn.uses.includes("L")) {
      children.push(
        field("Carried load (kg)", numberInput(this.params.L ?? 0, (v) => (this.params.L = v), { min: 0, max: 150, step: 1 }), { inline: true }),
      );
    }
    if (fn.uses.includes("N")) {
      children.push(
        field("Terrain coefficient", numberInput(this.params.N ?? 1, (v) => (this.params.N = v), { min: 0.5, max: 5, step: 0.05 }), {
          inline: true,
          hint: "1 for a paved road, higher for sand, scree or dense undergrowth.",
        }),
      );
    }
    if (fn.uses.includes("V")) {
      children.push(
        field("Speed (m/s)", numberInput(this.params.V ?? 1.2, (v) => (this.params.V = v), { min: 0, max: 4, step: 0.1 }), {
          inline: true,
          hint: "0 derives the speed from Tobler's function instead.",
        }),
      );
    }
    if (fn.uses.includes("slCrit")) {
      children.push(
        field("Critical slope (%)", numberInput(this.params.slCrit ?? 10, (v) => (this.params.slCrit = v), { min: 1, max: 30, step: 1 }), {
          inline: true,
          hint: "Typically 8–16 for wheeled vehicles.",
        }),
      );
    }

    children.push(
      field(
        "Movement directions",
        select(
          [
            { value: "4", label: "4 — rook" },
            { value: "8", label: "8 — queen" },
            { value: "16", label: "16 — knight and queen" },
          ],
          String(this.params.move ?? 16),
          (value) => {
            this.params.move = Number(value) as 4 | 8 | 16;
          },
        ),
        { hint: "More directions give straighter paths but cost roughly twice the time at 16." },
      ),
      checkbox(
        "Cognitive slope",
        this.params.cognSlope === true,
        (checked) => (this.params.cognSlope = checked),
        "Uses perceived rather than measured slope (Pingel 2013).",
      ),
      checkbox(
        "Terrain-based distance",
        this.params.topoDist === true,
        (checked) => (this.params.topoDist = checked),
        "Measures path length along the surface instead of in plan.",
      ),
    );

    const spec = getAnalysis(this.analysis);
    for (const extra of spec.extras) {
      children.push(this.renderExtra(extra));
    }

    return el("section", { class: "mcx-section" }, ...children);
  }

  private renderExtra(extra: ExtraField): HTMLElement {
    switch (extra.kind) {
      case "boolean":
        return checkbox(
          extra.label,
          Boolean(this.extras[extra.key]),
          (checked) => {
            this.extras[extra.key] = checked;
            this.render();
          },
          extra.hint,
        );
      case "number":
        return field(
          extra.label,
          numberInput(Number(this.extras[extra.key] ?? DEFAULT_PARAMS.lcpN ?? 3), (value) => {
            this.extras[extra.key] = value;
          }, { min: extra.min, max: extra.max, step: extra.step }),
          { inline: true, hint: extra.hint },
        );
      case "select":
        return field(
          extra.label,
          select(extra.options, String(this.extras[extra.key] ?? extra.options[0].value), (value) => {
            this.extras[extra.key] = value;
          }),
          { hint: extra.hint },
        );
      case "numberList":
      default:
        return field(
          extra.label,
          textInput(String(this.extras[extra.key] ?? ""), (value) => {
            this.extras[extra.key] = value;
          }, "e.g. 1, 2, 3"),
          { hint: extra.hint },
        );
    }
  }

  private renderDisplaySection(): HTMLElement {
    const ramp = getRamp(this.rampId);
    return el(
      "section",
      { class: "mcx-section" },
      el("h3", { class: "mcx-section__title", text: "5 · Raster display" }),
      field(
        "Colour ramp",
        select(
          COLOUR_RAMPS.map((r) => ({ value: r.id, label: r.label })),
          this.rampId,
          (value) => {
            this.rampId = value;
            this.render();
          },
        ),
        { inline: true },
      ),
      el("div", { class: "mcx-legend" }, renderLegend(ramp)),
      field(
        "Opacity",
        (() => {
          const slider = el("input", {
            class: "mcx-range",
            type: "range",
            min: 0,
            max: 1,
            step: 0.05,
            value: String(this.rasterOpacity),
          });
          slider.addEventListener("input", () => {
            this.rasterOpacity = Number(slider.value);
          });
          // Applied on release rather than per pixel: each change re-registers
          // the layer with the host.
          slider.addEventListener("change", () => {
            for (const layer of this.produced) {
              if (layer.kind === "raster") layer.handle?.setOpacity(this.rasterOpacity);
            }
          });
          return slider;
        })(),
        { inline: true },
      ),
    );
  }

  private renderRunSection(): HTMLElement {
    const status = el("div", { class: "mcx-status-host" });
    this.statusHost = status;

    const run = button(
      this.busy ? "Running…" : "Run analysis",
      () => void this.run(),
      "primary",
    );
    run.disabled = this.busy || !this.dtm;

    const section = el(
      "section",
      { class: "mcx-section mcx-section--run" },
      el("div", { class: "mcx-actions" }, run),
      status,
    );
    this.renderStatus();
    return section;
  }

  private renderResultsSection(): HTMLElement {
    const children: HTMLElement[] = [
      el("h3", { class: "mcx-section__title", text: "Results" }),
    ];

    const last = this.lastRun;
    if (!last) {
      children.push(note("Nothing yet. Results appear here and on the map.", "info"));
      return el("section", { class: "mcx-section" }, ...children);
    }

    if (!last.response.ok) {
      children.push(note(last.response.error, "error"));
      return el("section", { class: "mcx-section" }, ...children);
    }

    const { response } = last;
    children.push(
      el("p", {
        class: "mcx-summary",
        text: `${getAnalysis(response.analysis).label} — ${response.elapsedSeconds.toFixed(1)} s in ${response.crs}`,
      }),
    );

    if (this.produced.length) {
      const list = el("ul", { class: "mcx-layer-list" });
      for (const layer of this.produced) {
        const item = el("li", { class: "mcx-layer-list__item" }, el("span", { text: layer.label }));
        if (layer.preview) {
          // The thumbnail doubles as the fallback rendering when the host gave
          // us no way to draw the raster on the map.
          item.append(
            el(
              "div",
              { class: layer.handle ? "mcx-thumb" : "mcx-thumb mcx-thumb--only" },
              layer.preview.canvas,
              el("span", {
                class: "mcx-thumb__range",
                text: `${formatValue(layer.preview.min)} – ${formatValue(layer.preview.max)}${
                  layer.handle ? "" : " (not drawn on the map)"
                }`,
              }),
            ),
          );
        }
        list.append(item);
      }
      children.push(list);
      children.push(
        el(
          "div",
          { class: "mcx-actions" },
          button("Remove these result layers", () => {
            this.clearProduced();
            this.render();
          }, "ghost"),
          this.app.exportTextFile
            ? button("Export GeoJSON", () => this.exportResults(response), "secondary")
            : null!,
        ),
      );
    }

    const tables = response.result.tables;
    if (tables) {
      for (const [key, value] of Object.entries(tables)) {
        if (!value) continue;
        children.push(
          el("details", { class: "mcx-table" },
            el("summary", { text: key }),
            el("pre", { class: "mcx-pre", text: JSON.stringify(value, null, 2).slice(0, 20000) }),
          ),
        );
      }
    }

    if (response.log?.length) {
      children.push(
        el("details", { class: "mcx-table" },
          el("summary", { text: "Engine log" }),
          el("pre", { class: "mcx-pre", text: response.log.join("\n") }),
        ),
      );
    }

    return el("section", { class: "mcx-section" }, ...children);
  }

  // --- behaviour -------------------------------------------------------------

  private async loadDtm(file: File): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      this.dtm = { name: file.name, bytes: new Uint8Array(buffer) };
      this.useArea = false;
      this.message = null;
      this.render();
      await this.showTerrain();
    } catch (error) {
      this.message = { text: `Could not read the DTM: ${describeError(error)}`, tone: "error" };
      this.render();
    }
  }

  /**
   * Draws the loaded DTM on the map.
   *
   * Seeing the terrain before running matters: it is the fastest way to notice
   * that the download covered the wrong area, or that the uploaded DTM has a
   * hole where the study area is. Failure is non-fatal — the analysis does not
   * depend on it — so problems are reported and then dropped.
   */
  private async showTerrain(): Promise<void> {
    this.clearTerrainOverlay();
    if (!this.dtm) return;
    const backend = await this.resolveBackend();
    if (typeof backend.previewDtm !== "function") return;

    try {
      const preview = await backend.previewDtm(this.dtm.bytes, this.dtm.handle ?? null);
      this.terrainPreview = preview;
      this.terrainOverlay = addHostRasterLayer(this.app, decodeRaster(preview.raster), {
        id: TERRAIN_LAYER_ID,
        name: `DEM — ${this.dtm.name}`,
        ramp: "terrain",
        opacity: 0.85,
      });
      this.terrainVisible = true;
      // Re-add the markers so they sit above the terrain in the stack.
      this.refreshMarkers("origin", true);
      this.refreshMarkers("destination", true);
      this.groupInputs();
      const b = preview.raster.bounds;
      this.app.fitBounds?.([b.west, b.south, b.east, b.north]);
    } catch (error) {
      this.message = {
        text: `The terrain preview failed (the analysis will still work): ${describeError(error)}`,
        tone: "warn",
      };
    }
    this.render();
  }

  private clearTerrainOverlay(): void {
    try {
      this.terrainOverlay?.remove();
    } catch {
      /* the layer may already be gone */
    }
    this.terrainOverlay = null;
    this.terrainPreview = null;
  }

  private startPicking(which: "origin" | "destination"): void {
    this.cancelPicking();
    const session = startPointPicking(this.app, (lng, lat) => {
      const set = which === "origin" ? this.origin : this.destination;
      const spec = getAnalysis(this.analysis);
      const limit = which === "origin" ? spec.origin.max : spec.destination?.max;
      const features = limit && set.features.length >= limit ? [] : set.features.slice();
      features.push(makePointFeature(lng, lat, `${which[0].toUpperCase()}${features.length + 1}`));
      const next: PointSet = { kind: "click", label: "map clicks", features };
      if (which === "origin") this.origin = next;
      else this.destination = next;
      this.refreshMarkers(which);
      this.render();
    });
    if (!session) {
      this.message = { text: "This GeoLibre build does not expose the map to plugins, so click-to-place is unavailable.", tone: "warn" };
      this.render();
      return;
    }
    this.picking = which;
    this.stopPicking = session.stop;
    this.render();
  }

  private cancelPicking(): void {
    this.stopPicking?.();
    this.stopPicking = null;
    this.picking = null;
  }

  private setPoints(
    which: "origin" | "destination",
    set: PointSet,
    min: number,
    max?: number,
  ): void {
    let features = set.features;
    if (max && features.length > max) features = features.slice(0, max);
    const next = { ...set, features };
    if (which === "origin") this.origin = next;
    else this.destination = next;

    if (set.features.length === 0) {
      this.message = { text: "No point features found in that source.", tone: "warn" };
    } else if (features.length < min) {
      this.message = { text: `That source has ${features.length} point(s); this analysis needs at least ${min}.`, tone: "warn" };
    } else {
      this.message = null;
    }
    this.refreshMarkers(which);
    this.render();
  }

  /**
   * Keeps the marker layer for one point set in step with the panel state.
   *
   * Origins and destinations are separate host layers with distinct styles
   * (green circles, red triangles — see styles.ts), each labelled with the id
   * the engine will use, so a click shows up on the map at once and the cost
   * table can be read back against it. An empty set removes the layer.
   */
  private refreshMarkers(which: "origin" | "destination", raise = false): void {
    const set = which === "origin" ? this.origin : this.destination;
    const prefix = which === "origin" ? "O" : "D";
    const features = set.features.map((feature, index) => ({
      ...feature,
      properties: { ...(feature.properties ?? {}), mcx_id: `${prefix}${index + 1}`, mcx_role: which },
    }));

    if (!hostOwnsLayers(this.app)) {
      const map = this.app.getMap?.() ?? null;
      this.rawMarkerCleanup[which]?.();
      this.rawMarkerCleanup[which] = null;
      if (map && features.length) {
        this.rawMarkerCleanup[which] = addRawMarkerLayer(
          map,
          which === "origin" ? ORIGIN_LAYER_ID : DESTINATION_LAYER_ID,
          features,
          which === "origin" ? "#16a34a" : "#dc2626",
        );
      }
      return;
    }

    if (!features.length || raise) {
      this.markers[which]?.remove();
      this.markers[which] = null;
    }
    if (!features.length) return;

    const spec = getAnalysis(this.analysis);
    const label = which === "origin" ? spec.origin.label : spec.destination?.label ?? "Destinations";
    this.markers[which] = addHostVectorLayer(this.app, {
      id: which === "origin" ? ORIGIN_LAYER_ID : DESTINATION_LAYER_ID,
      name: `${label} (${features.length})`,
      features,
      style: which === "origin" ? ORIGIN_STYLE : DESTINATION_STYLE,
    });
    this.groupInputs();
  }

  private clearMarkers(): void {
    for (const which of ["origin", "destination"] as const) {
      this.markers[which]?.remove();
      this.markers[which] = null;
      this.rawMarkerCleanup[which]?.();
      this.rawMarkerCleanup[which] = null;
    }
  }

  /** Terrain and markers share one Layers-panel group. */
  private groupInputs(): void {
    const ids = [this.terrainOverlay, this.markers.origin, this.markers.destination]
      .filter((h): h is HostLayerHandle => Boolean(h))
      .map((h) => h.id);
    this.inputGroupId = groupHostLayers(this.app, INPUT_GROUP_NAME, ids, this.inputGroupId);
  }

  /**
   * Layers offered as point / barrier sources: everything the host lists except
   * the plugin's own marker layers, which would only feed the panel back its
   * own state.
   */
  private candidateLayers() {
    return listVectorLayers(this.app).filter(
      (layer) => layer.id !== ORIGIN_LAYER_ID && layer.id !== DESTINATION_LAYER_ID,
    );
  }


  private collectParams(): AnalysisParams {
    const params: AnalysisParams = { ...this.params };
    // The extras table is keyed by string, so widen once rather than casting per write.
    const writable = params as unknown as Record<string, unknown>;
    const spec = getAnalysis(this.analysis);
    for (const extra of spec.extras) {
      const value = this.extras[extra.key];
      if (value === undefined || value === "") continue;
      if (extra.kind === "numberList") {
        const numbers = String(value)
          .split(/[,;\s]+/)
          .map((part) => Number(part))
          .filter((n) => Number.isFinite(n));
        if (numbers.length) writable[extra.key] = numbers;
      } else {
        writable[extra.key] = value;
      }
    }
    if (!isTimeFunction(params.funct)) delete params.time;
    // Only meaningful when movecost resolves the terrain itself.
    if (!this.dtm && this.useArea) params.zoom = this.demZoom;
    return params;
  }

  private validate(params: AnalysisParams): string | null {
    const spec = getAnalysis(this.analysis);
    if (!this.dtm && !(this.useArea && this.area)) {
      return "Load a DTM, download one for an area, or choose to use the area directly.";
    }
    if (this.origin.features.length < spec.origin.min) {
      return `${spec.origin.label} needs at least ${spec.origin.min} point(s).`;
    }
    if (spec.destination && this.destination.features.length < spec.destination.min) {
      return `${spec.destination.label} needs at least ${spec.destination.min} point(s).`;
    }
    if (this.analysis === "boundary" && !(params.contValue?.length)) {
      return "Enter at least one cost limit for the boundary analysis.";
    }
    return null;
  }

  private async run(): Promise<void> {
    const params = this.collectParams();
    const problem = this.validate(params);
    if (problem) {
      this.message = { text: problem, tone: "warn" };
      this.render();
      return;
    }

    this.cancelPicking();
    this.busy = true;
    this.message = null;
    this.render();

    try {
      const spec = getAnalysis(this.analysis);
      const backend = await this.resolveBackend();
      const response = await backend.run(
        { analysis: this.analysis, params },
        {
          dtm: this.dtm && !this.dtm.handle ? this.dtm.bytes : null,
          dtmHandle: this.dtm?.handle ?? null,
          studyplot:
            !this.dtm && this.area
              ? JSON.stringify(toFeatureCollection(this.area.features))
              : null,
          origin: pointsToGeoJson(this.origin.features, "O"),
          destin: spec.destination ? pointsToGeoJson(this.destination.features, "D") : null,
          barrier: this.barrier.features.length
            ? JSON.stringify(toFeatureCollection(this.barrier.features))
            : null,
        },
      );

      // Earlier runs stay on the map, in their own groups, so cost functions
      // can be compared; the Layers panel removes a whole group in one go.
      this.produced = [];
      if (response.ok) {
        this.addResultsToMap(response);
        this.message = null;
      } else {
        this.message = { text: withMemoryHint(response.error, this.cellBudget().where), tone: "error" };
      }
      this.lastRun = { response, layers: this.produced };
    } catch (error) {
      this.message = { text: withMemoryHint(describeError(error), this.cellBudget().where), tone: "error" };
      this.lastRun = null;
    } finally {
      this.busy = false;
      this.progress = null;
      this.render();
    }
  }

  /**
   * Puts one run's outputs on the map as host layers in a group of their own.
   *
   * Rasters go first so the vectors drawn from them sit on top; the group is
   * numbered per run so two runs with different cost functions can be
   * compared side by side rather than overwriting each other.
   */
  private addResultsToMap(response: Extract<EngineResponse, { ok: true }>): void {
    const spec = getAnalysis(response.analysis);
    this.runCount += 1;
    const layerIds: string[] = [];
    let bounds: [number, number, number, number] | null = null;

    for (const [key, payload] of Object.entries(response.result.rasters)) {
      const meta = spec.layers[key];
      const label = meta?.label ?? key;
      const { handle, preview } = this.addRaster(payload, label);
      if (handle) {
        layerIds.push(handle.id);
        bounds = unionBounds(bounds, handle.bounds);
      }
      if (handle || preview) this.produced.push({ label, kind: "raster", handle, preview });
    }

    for (const [key, geojson] of Object.entries(response.result.vectors)) {
      const meta = spec.layers[key];
      const label = meta?.label ?? key;
      try {
        const collection = JSON.parse(geojson) as { features: GeoJsonFeature[] };
        const features = collection.features ?? [];
        if (!features.length) continue;
        const handle = addHostVectorLayer(this.app, {
          name: label,
          features,
          style: resultStyle(key, meta?.kind ?? "line"),
        });
        if (!handle) continue;
        layerIds.push(handle.id);
        bounds = unionBounds(bounds, boundsOf(features));
        this.produced.push({ label, kind: "vector", handle });
      } catch (error) {
        this.message = { text: `Could not add "${label}": ${describeError(error)}`, tone: "warn" };
      }
    }

    groupHostLayers(this.app, `movecost · ${spec.label} #${this.runCount}`, layerIds, null);

    if (bounds) this.app.fitBounds?.(bounds);
  }

  /**
   * Draws a raster result, degrading in three steps: a host-owned image layer,
   * a self-healing raw MapLibre overlay (inside `addHostRasterLayer`), and
   * finally a thumbnail in the panel — which is kept in every case, as a
   * readout of the value range.
   */
  private addRaster(
    payload: RasterPayload,
    label: string,
  ): { handle: HostLayerHandle | null; preview?: ProducedLayer["preview"] } {
    let decoded;
    try {
      decoded = decodeRaster(payload);
    } catch (error) {
      this.message = { text: `Could not decode "${label}": ${describeError(error)}`, tone: "warn" };
      return { handle: null };
    }
    let preview: ProducedLayer["preview"];
    try {
      preview = {
        canvas: renderRasterThumbnail(decoded, { ramp: this.rampId }),
        min: decoded.min,
        max: decoded.max,
      };
    } catch {
      preview = undefined;
    }
    try {
      const handle = addHostRasterLayer(this.app, decoded, {
        name: label,
        ramp: this.rampId,
        opacity: this.rasterOpacity,
      });
      if (!handle) {
        this.message = {
          text: "This GeoLibre build exposes neither a layer registry nor the map to plugins, so raster results are shown here in the panel only. Vector results are unaffected.",
          tone: "warn",
        };
      }
      return { handle, preview };
    } catch (error) {
      this.message = { text: `Could not draw "${label}": ${describeError(error)}`, tone: "warn" };
      return { handle: null, preview };
    }
  }

  private clearProduced(): void {
    for (const layer of this.produced) {
      try {
        layer.handle?.remove();
      } catch {
        /* the layer may already be gone */
      }
    }
    this.produced = [];
  }


  private exportResults(response: Extract<EngineResponse, { ok: true }>): void {
    const features: GeoJsonFeature[] = [];
    for (const [key, geojson] of Object.entries(response.result.vectors)) {
      try {
        const parsed = JSON.parse(geojson) as { features: GeoJsonFeature[] };
        for (const feature of parsed.features ?? []) {
          features.push({
            ...feature,
            properties: { ...(feature.properties ?? {}), mcx_layer: key },
          });
        }
      } catch {
        /* skip an unparseable layer rather than losing the rest */
      }
    }
    this.app.exportTextFile?.(
      `movecost-${response.analysis}.geojson`,
      JSON.stringify(toFeatureCollection(features)),
    );
  }
}
