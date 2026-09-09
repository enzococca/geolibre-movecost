import type {
  AnalysisId,
  AnalysisParams,
  DtmPreview,
  EngineInputs,
  EngineResponse,
  ProgressEvent,
} from "./types";
import type { ElevationGrid } from "../map/terrain-tiles";

/**
 * What the panel talks to. Two implementations exist — a local R service over
 * HTTP, and webR in the page — and the panel does not care which it has.
 */
/** Summary of a DEM downloaded for a drawn area. */
export interface DemSummary {
  crs: string;
  zoom: number;
  width: number;
  height: number;
  /** Cell size in metres, in the projected CRS. */
  resolution: number;
  elevation: { min: number | null; max: number | null };
  bounds: { west: number; south: number; east: number; north: number };
  bytes: number;
  elapsedSeconds?: number;
}

export interface DemResult {
  /** GeoTIFF bytes; empty when the backend keeps the DTM in its own session. */
  bytes: Uint8Array;
  /** Set when the DTM lives in the backend's R session instead of `bytes`. */
  handle?: string;
  summary: DemSummary;
}

export interface AnalysisBackend {
  readonly id: "local-r" | "webr";
  /** Shown in the panel so the user knows where their analysis is running. */
  readonly label: string;
  /** Versions of R and the packages actually doing the work, once known. */
  readonly versions: Record<string, string> | null;
  onProgress(listener: (event: ProgressEvent) => void): () => void;
  run(
    request: { analysis: AnalysisId; params: AnalysisParams },
    inputs: EngineInputs,
  ): Promise<EngineResponse>;
  /**
   * Download elevation for a drawn area. Optional: it needs outbound network
   * access and the elevatr package, which only the local R service has.
   */
  fetchDem?: (areaGeoJson: string, zoom: number) => Promise<DemResult>;
  /** Summarise a loaded DTM so it can be drawn on the map. */
  previewDtm?: (dtm: Uint8Array, handle?: string | null) => Promise<DtmPreview>;
  /**
   * Turn a grid the page fetched itself (see `map/terrain-tiles.ts`) into a
   * projected GeoTIFF. This is how the in-browser backend gets terrain for a
   * drawn area: the tiles are public, R just cannot fetch them from inside webR.
   */
  dtmFromGrid?: (grid: ElevationGrid, areaGeoJson: string | null) => Promise<DemResult>;
  close(): Promise<void>;
}

/** Shared by both backends: the summary the R side writes, unboxed. */
export function parseDemSummary(raw: Record<string, unknown>): DemSummary {
  // plumber's toJSON boxes scalars into single-element arrays in places, so
  // unwrap rather than trusting the shape.
  const scalar = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const elevation = (raw.elevation ?? {}) as Record<string, unknown>;
  const b = (raw.bounds ?? {}) as Record<string, unknown>;
  return {
    crs: String(scalar(raw.crs)),
    zoom: Number(scalar(raw.zoom)),
    width: Number(scalar(raw.width)),
    height: Number(scalar(raw.height)),
    resolution: Number(scalar(raw.resolution)),
    bytes: Number(scalar(raw.bytes)),
    elapsedSeconds: Number(scalar(raw.elapsedSeconds)),
    elevation: { min: Number(scalar(elevation.min)), max: Number(scalar(elevation.max)) },
    bounds: {
      west: Number(scalar(b.west)),
      south: Number(scalar(b.south)),
      east: Number(scalar(b.east)),
      north: Number(scalar(b.north)),
    },
  };
}

/** Where the local R service is expected. Overridable without a rebuild. */
export const DEFAULT_BACKEND_URL =
  readOverride("MOVECOST_BACKEND_URL") ?? "http://127.0.0.1:8787";

function readOverride(key: string): string | null {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value && value.trim() ? value.trim().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

export interface BackendHealth {
  ok: boolean;
  service?: string;
  api?: number;
  versions?: Record<string, string>;
  analyses?: string[];
}

/**
 * True on iPad, iPhone and Android, where no local R service can exist. Modern
 * iPadOS reports itself as a Mac, hence the touch-point check.
 */
export function isMobileDevice(): boolean {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad/i.test(ua)) return true;
  return /Mac/.test(ua) && navigator.maxTouchPoints > 1;
}

/**
 * Probes the local R service.
 *
 * Deliberately short-timeout and failure-tolerant: on a machine without the
 * service running this is a connection refusal within milliseconds, and the
 * plugin simply carries on with its other backend.
 */
export async function probeBackend(
  url: string = DEFAULT_BACKEND_URL,
  timeoutMs = 1500,
): Promise<BackendHealth | null> {
  // Skipped rather than attempted on mobile: the refusal is instant, but the
  // host logs it as a red network error in its diagnostics panel.
  if (isMobileDevice()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const health = (await response.json()) as BackendHealth;
    return health?.ok ? health : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs analyses on a local R process through the plumber API in `r-backend/`.
 *
 * This is the fast path: real movecost, native speed, no download, and it
 * handles DTMs far larger than a browser runtime would.
 */
export class HttpBackend implements AnalysisBackend {
  readonly id = "local-r" as const;
  private listeners = new Set<(event: ProgressEvent) => void>();

  constructor(
    private readonly url: string = DEFAULT_BACKEND_URL,
    public versions: Record<string, string> | null = null,
  ) {}

  get label(): string {
    const movecost = this.versions?.movecost;
    return movecost ? `Local R service (movecost ${movecost})` : "Local R service";
  }

  onProgress(listener: (event: ProgressEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(phase: ProgressEvent["phase"], message: string, fraction: number | null = null) {
    for (const listener of this.listeners) {
      try {
        listener({ phase, message, fraction });
      } catch {
        /* a broken listener must not abort an analysis */
      }
    }
  }

  async run(
    request: { analysis: AnalysisId; params: AnalysisParams },
    inputs: EngineInputs,
  ): Promise<EngineResponse> {
    const form = new FormData();
    if (inputs.dtm) {
      form.append("dtm", new Blob([inputs.dtm as BlobPart], { type: "image/tiff" }), "dtm.tif");
    }
    if (inputs.studyplot) form.append("studyplot", inputs.studyplot);
    form.append("origin", inputs.origin);
    if (inputs.destin) form.append("destin", inputs.destin);
    if (inputs.barrier) form.append("barrier", inputs.barrier);
    form.append("request", JSON.stringify(request));

    this.emit(
      "running",
      inputs.dtm
        ? `Running the ${request.analysis} analysis on the local R service…`
        : `Downloading elevation, then running the ${request.analysis} analysis…`,
      null,
    );

    let response: Response;
    try {
      response = await fetch(`${this.url}/run`, { method: "POST", body: form });
    } catch (error) {
      this.emit("error", "The local R service stopped responding.");
      return {
        ok: false,
        error:
          `Could not reach the local R service at ${this.url}. ` +
          `Start it with "Rscript r-backend/start.R" from the plugin project. ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      };
    }

    let payload: EngineResponse;
    try {
      payload = (await response.json()) as EngineResponse;
    } catch {
      this.emit("error", "The local R service returned something that is not JSON.");
      return {
        ok: false,
        error: `The local R service replied with HTTP ${response.status} and a body that is not JSON.`,
      };
    }

    this.emit(payload.ok ? "done" : "error", payload.ok ? "Analysis complete." : payload.error, 1);
    return payload;
  }

  async fetchDem(areaGeoJson: string, zoom: number): Promise<DemResult> {
    const form = new FormData();
    form.append("area", areaGeoJson);
    form.append("zoom", String(zoom));

    this.emit("running", `Downloading elevation tiles at zoom ${zoom}…`, null);
    const response = await fetch(`${this.url}/dem`, { method: "POST", body: form });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body?.error) detail = body.error;
      } catch {
        /* keep the status line */
      }
      this.emit("error", detail, 1);
      throw new Error(detail);
    }

    const header = response.headers.get("X-Movecost-Summary");
    if (!header) {
      throw new Error(
        "The DEM came back without its summary header. The R service may be an older version.",
      );
    }
    const summary = parseDemSummary(JSON.parse(header) as Record<string, unknown>);

    const bytes = new Uint8Array(await response.arrayBuffer());
    this.emit("done", `Downloaded a ${summary.width} x ${summary.height} DEM.`, 1);
    return { bytes, summary };
  }

  async dtmFromGrid(grid: ElevationGrid, areaGeoJson: string | null): Promise<DemResult> {
    const form = new FormData();
    const bytes = new Uint8Array(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength);
    form.append("grid", new Blob([bytes as BlobPart], { type: "application/octet-stream" }), "grid.bin");
    form.append(
      "meta",
      JSON.stringify({
        width: grid.width, height: grid.height, crs: grid.crs, zoom: grid.zoom,
        xmin: grid.xmin, ymin: grid.ymin, xmax: grid.xmax, ymax: grid.ymax,
      }),
    );
    if (areaGeoJson) form.append("area", areaGeoJson);

    this.emit("running", "Projecting the elevation grid…", null);
    const response = await fetch(`${this.url}/grid`, { method: "POST", body: form });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body?.error) detail = body.error;
      } catch {
        /* keep the status line */
      }
      this.emit("error", detail, 1);
      throw new Error(detail);
    }
    const header = response.headers.get("X-Movecost-Summary");
    if (!header) throw new Error("The DTM came back without its summary header.");
    const summary = parseDemSummary(JSON.parse(header) as Record<string, unknown>);
    const tif = new Uint8Array(await response.arrayBuffer());
    this.emit("done", `Built a ${summary.width} x ${summary.height} DTM.`, 1);
    return { bytes: tif, summary };
  }

  async previewDtm(dtm: Uint8Array, handle?: string | null): Promise<DtmPreview> {
    if (handle) throw new Error("The local R service holds no DTM handles; send the GeoTIFF instead.");
    const form = new FormData();
    form.append("dtm", new Blob([dtm as BlobPart], { type: "image/tiff" }), "dtm.tif");
    const response = await fetch(`${this.url}/preview`, { method: "POST", body: form });
    const payload = (await response.json()) as { ok: boolean; error?: string } & DtmPreview;
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }
    return payload;
  }

  async close(): Promise<void> {
    // The service outlives the plugin; nothing to tear down here.
    this.listeners.clear();
  }
}
