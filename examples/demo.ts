/**
 * Browser harness for the movecost engine.
 *
 * Deliberately does not import anything from the plugin UI: this page exists to
 * answer one question — does webR actually run movecost in a browser, and does
 * the request/response contract hold? — so it drives `MovecostEngine` directly.
 */
import { MovecostEngine } from "../src/engine/webr-runtime";
import { DEFAULT_BACKEND_URL, HttpBackend, probeBackend, type AnalysisBackend } from "../src/engine/backend";
import { decodeRaster, renderRasterToCanvas } from "../src/map/raster-overlay";
import type { AnalysisId, AnalysisParams } from "../src/engine/types";
import { fetchTerrariumGrid } from "../src/map/terrain-tiles";

const statusEl = document.getElementById("status") as HTMLElement;
const barEl = document.querySelector("#bar > div") as HTMLElement;
const outEl = document.getElementById("out") as HTMLElement;
const canvasEl = document.getElementById("raster") as HTMLCanvasElement;
const runButton = document.getElementById("run") as HTMLButtonElement;
const analysisEl = document.getElementById("analysis") as HTMLSelectElement;
const functEl = document.getElementById("funct") as HTMLSelectElement;

let engine: AnalysisBackend = new MovecostEngine();

/** Prefer the local R service when it answers, exactly as the plugin panel does. */
const ready = (async () => {
  const health = await probeBackend(DEFAULT_BACKEND_URL);
  if (health) {
    engine = new HttpBackend(DEFAULT_BACKEND_URL, health.versions ?? null);
  }
  (window as unknown as Record<string, unknown>).mcx = { engine, fetchTerrariumGrid };
  statusEl.textContent = `Backend: ${engine.label}`;
  return engine;
})();
void ready.then((backend) => {
  backend.onProgress((event) => {
    statusEl.textContent = event.message;
    barEl.style.width = event.fraction === null ? "35%" : `${Math.round(event.fraction * 100)}%`;
  });
});

/**
 * Points come from `points.json`, generated next to the DTM by
 * `scripts/make-demo-dtm.R`, so they always fall inside the raster.
 */
interface DemoPoint {
  id: string;
  lng: number;
  lat: number;
}

let demoPoints: DemoPoint[] = [];

function fc(points: DemoPoint[]) {
  return JSON.stringify({
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: { mcx_id: p.id },
    })),
  });
}

function pick(...ids: string[]): DemoPoint[] {
  return ids
    .map((id) => demoPoints.find((p) => p.id === id))
    .filter((p): p is DemoPoint => Boolean(p));
}

function inputsFor(analysis: AnalysisId) {
  switch (analysis) {
    case "network":
    case "allocation":
      return { origin: fc(pick("O1", "O2", "O3")), destin: null };
    case "paths":
      return { origin: fc(pick("O1")), destin: fc(pick("D1", "D2")) };
    case "boundary":
      return { origin: fc(pick("O1")), destin: null };
    default:
      return { origin: fc(pick("O1")), destin: fc(pick("D1")) };
  }
}

function paramsFor(analysis: AnalysisId): AnalysisParams {
  const params: AnalysisParams = { funct: functEl.value, time: "h", move: 8 };
  if (analysis === "boundary") params.contValue = [1];
  if (analysis === "rank") params.lcpN = 3;
  if (analysis === "network") params.netwType = "allpairs";
  return params;
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  outEl.textContent = "…";
  const started = performance.now();
  try {
    if (!demoPoints.length) {
      const meta = (await (await fetch("./points.json")).json()) as { points: DemoPoint[] };
      demoPoints = meta.points;
    }
    const dtm = new Uint8Array(await (await fetch("./dtm.tif")).arrayBuffer());
    const analysis = analysisEl.value as AnalysisId;
    const { origin, destin } = inputsFor(analysis);

    const backend = await ready;
    const response = await backend.run(
      { analysis, params: paramsFor(analysis) },
      { dtm, origin, destin },
    );

    const wall = ((performance.now() - started) / 1000).toFixed(1);
    if (!response.ok) {
      statusEl.textContent = `Failed after ${wall} s`;
      outEl.textContent = `ERROR: ${response.error}\n\n${(response.log ?? []).join("\n")}`;
      return;
    }

    const summary = {
      analysis: response.analysis,
      crs: response.crs,
      rSeconds: Number(response.elapsedSeconds.toFixed(2)),
      wallSeconds: Number(wall),
      versions: response.versions,
      vectors: Object.fromEntries(
        Object.entries(response.result.vectors).map(([key, value]) => {
          const parsed = JSON.parse(value) as { features: unknown[] };
          return [key, `${parsed.features.length} feature(s), ${value.length} bytes`];
        }),
      ),
      rasters: Object.fromEntries(
        Object.entries(response.result.rasters).map(([key, r]) => [
          key,
          `${r.width}x${r.height}, range ${r.min?.toFixed(3)}..${r.max?.toFixed(3)}`,
        ]),
      ),
      log: response.log,
    };
    outEl.textContent = JSON.stringify(summary, null, 2);
    statusEl.textContent = `Done in ${wall} s`;

    const first = Object.values(response.result.rasters)[0];
    const ctx = canvasEl.getContext("2d")!;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (first) {
      const painted = renderRasterToCanvas(decodeRaster(first), { ramp: "viridis" });
      canvasEl.width = painted.width;
      canvasEl.height = painted.height;
      canvasEl.getContext("2d")!.drawImage(painted, 0, 0);
    }
  } catch (error) {
    statusEl.textContent = "Crashed.";
    outEl.textContent = String(error instanceof Error ? error.stack ?? error.message : error);
  } finally {
    runButton.disabled = false;
  }
});
