/** The wire format shared with `movecost-engine.R`. */

export type AnalysisId =
  | "paths"
  | "corridor"
  | "network"
  | "allocation"
  | "boundary"
  | "rank";

export interface AnalysisParams {
  /** movecost cost-function code, e.g. "t" for Tobler on-path. */
  funct: string;
  /** "h" or "m"; only meaningful for time-based cost functions. */
  time?: "h" | "m";
  /** Neighbourhood used to build the transition matrix. */
  move?: 4 | 8 | 16;
  /** Conductance value assigned to barrier cells. */
  field?: number;
  cognSlope?: boolean;
  topoDist?: boolean;
  /** Critical slope in percent; wheeled-vehicle cost function only. */
  slCrit?: number;
  /** Body weight in kg (Pandolf, Van Leusen). */
  W?: number;
  /** Carried load in kg (Pandolf, Van Leusen). */
  L?: number;
  /** Terrain coefficient / ease of movement. */
  N?: number;
  /** Speed in m/s (Pandolf, Van Leusen, Ardigo). */
  V?: number;
  irregularDtm?: boolean;
  autoReproject?: boolean;
  /** elevatr zoom level, used only when movecost downloads the terrain itself. */
  zoom?: number;

  /** paths */
  breaks?: number[];
  returnBase?: boolean;
  /** corridor */
  rescale?: boolean;
  /** network */
  netwType?: "allpairs" | "neigh";
  lcpDensity?: boolean;
  /** allocation */
  isolines?: boolean;
  /** boundary */
  contValue?: number[];
  /** rank */
  lcpN?: number;
  useCorridor?: boolean;
}

export interface EngineRequest {
  analysis: AnalysisId;
  /** Absent when `studyplotPath` is given and movecost fetches the terrain. */
  dtmPath?: string | null;
  dtmHandle?: string | null;
  studyplotPath?: string | null;
  originPath: string;
  destinPath?: string | null;
  barrierPath?: string | null;
  params: AnalysisParams;
}

/**
 * A raster travels as a base64 little-endian Float32 array in WGS84, with NaN
 * standing in for NoData. That avoids shipping a GeoTIFF decoder in the bundle
 * and lets the overlay pick its own colour ramp.
 */
export interface RasterPayload {
  name: string;
  width: number;
  height: number;
  bounds: { west: number; south: number; east: number; north: number };
  min: number | null;
  max: number | null;
  data: string;
}

export interface EngineResult {
  /** Layer key -> GeoJSON text, already in EPSG:4326. */
  vectors: Record<string, string>;
  rasters: Record<string, RasterPayload>;
  tables?: Record<string, unknown>;
}

export interface EngineResponseOk {
  ok: true;
  analysis: AnalysisId;
  crs: string;
  elapsedSeconds: number;
  versions: Record<string, string>;
  log: string[];
  result: EngineResult;
}

export interface EngineResponseError {
  ok: false;
  error: string;
  log?: string[];
  elapsedSeconds?: number;
}

export type EngineResponse = EngineResponseOk | EngineResponseError;

export interface EngineInputs {
  /** Raw GeoTIFF bytes of the digital terrain model, when one is loaded. */
  dtm?: Uint8Array | null;
  /**
   * A DTM the backend already holds in its R session (webR keeps downloaded
   * terrain in memory rather than writing a GeoTIFF). Takes precedence over
   * `dtm` when set.
   */
  dtmHandle?: string | null;
  /**
   * GeoJSON polygon to derive the terrain from instead. movecost's own
   * `studyplot` path: it downloads elevation for the area on every run.
   */
  studyplot?: string | null;
  /** GeoJSON text for the origin points. */
  origin: string;
  destin?: string | null;
  barrier?: string | null;
}

/** What `POST /preview` returns for a loaded DTM. */
export interface DtmPreview {
  crs: string;
  width: number;
  height: number;
  /** Cell size in metres. */
  resolution: number;
  elevation: { min: number | null; max: number | null };
  raster: RasterPayload;
}

export type ProgressPhase =
  | "idle"
  | "downloading-r"
  | "installing-packages"
  | "loading-engine"
  | "running"
  | "reading-results"
  | "done"
  | "error";

export interface ProgressEvent {
  phase: ProgressPhase;
  message: string;
  /** 0..1 when known, otherwise null for an indeterminate bar. */
  fraction: number | null;
}
