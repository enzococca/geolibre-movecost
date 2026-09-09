import type { RasterPayload } from "../engine/types";
import type { GeoLibreAppAPI, MapLibreLike } from "../types/geolibre";

/**
 * Paints an engine raster payload onto the map as an image overlay.
 *
 * The host API has native layer helpers for tiles, COGs and Zarr stores, but
 * none for an in-memory grid, so accumulated-cost surfaces go on as a MapLibre
 * `image` source built from a canvas. Those layers live outside the Layers
 * panel, which is why this module keeps its own registry and the plugin panel
 * exposes its own visibility and removal controls.
 */

export interface ColourRamp {
  id: string;
  label: string;
  /** RGB stops, low cost first. */
  stops: [number, number, number][];
}

export const COLOUR_RAMPS: ColourRamp[] = [
  {
    id: "viridis",
    label: "Viridis",
    stops: [
      [68, 1, 84],
      [59, 82, 139],
      [33, 145, 140],
      [94, 201, 98],
      [253, 231, 37],
    ],
  },
  {
    id: "inferno",
    label: "Inferno",
    stops: [
      [0, 0, 4],
      [87, 16, 110],
      [188, 55, 84],
      [249, 142, 9],
      [252, 255, 164],
    ],
  },
  {
    id: "terrain",
    label: "Terrain",
    stops: [
      [0, 97, 71],
      [124, 179, 89],
      [232, 220, 150],
      [176, 132, 92],
      [255, 255, 255],
    ],
  },
  {
    id: "greyscale",
    label: "Greyscale",
    stops: [
      [20, 20, 20],
      [245, 245, 245],
    ],
  },
];

export function getRamp(id: string): ColourRamp {
  return COLOUR_RAMPS.find((r) => r.id === id) ?? COLOUR_RAMPS[0];
}

export interface DecodedRaster {
  values: Float32Array;
  width: number;
  height: number;
  min: number;
  max: number;
  bounds: RasterPayload["bounds"];
}

/** Decodes the base64 Float32 payload and recomputes the range over real data. */
export function decodeRaster(payload: RasterPayload): DecodedRaster {
  const binary = atob(payload.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 0;
  }

  return {
    values,
    width: payload.width,
    height: payload.height,
    min,
    max,
    bounds: payload.bounds,
  };
}

function sample(ramp: ColourRamp, t: number): [number, number, number] {
  const stops = ramp.stops;
  if (t <= 0) return stops[0];
  if (t >= 1) return stops[stops.length - 1];
  const scaled = t * (stops.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export interface RenderOptions {
  ramp?: string;
  /** 0..1; applied per pixel so NoData stays fully transparent. */
  opacity?: number;
  /** Clamp the colour range, e.g. to drop a long tail of unreachable cells. */
  min?: number;
  max?: number;
  reverse?: boolean;
}

export function renderRasterToCanvas(
  raster: DecodedRaster,
  options: RenderOptions = {},
): HTMLCanvasElement {
  const ramp = getRamp(options.ramp ?? "viridis");
  const alpha = Math.round(255 * (options.opacity ?? 1));
  const lo = options.min ?? raster.min;
  const hi = options.max ?? raster.max;
  const span = hi - lo || 1;

  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser refused a 2D canvas context.");

  const image = ctx.createImageData(raster.width, raster.height);
  const out = image.data;
  for (let i = 0; i < raster.values.length; i += 1) {
    const v = raster.values[i];
    const o = i * 4;
    if (Number.isNaN(v)) {
      out[o + 3] = 0;
      continue;
    }
    let t = (v - lo) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const [r, g, b] = sample(ramp, options.reverse ? 1 - t : t);
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = alpha;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export interface OverlayHandle {
  id: string;
  sourceId: string;
  layerId: string;
  bounds: [number, number, number, number];
  remove: () => void;
  setVisible: (visible: boolean) => void;
  setOpacity: (opacity: number) => void;
}

let overlaySeq = 0;

/**
 * Adds a decoded raster to the map. Returns null when the host does not expose
 * the MapLibre instance — the caller then falls back to the panel preview,
 * which is why the whole path is optional-chained.
 */
export function addRasterOverlay(
  app: GeoLibreAppAPI,
  raster: DecodedRaster,
  options: RenderOptions & { name: string },
): OverlayHandle | null {
  const map = app.getMap?.() ?? null;
  if (!map) return null;

  const canvas = renderRasterToCanvas(raster, options);
  const id = `movecost-raster-${(overlaySeq += 1)}`;
  const sourceId = `${id}-source`;
  const { west, south, east, north } = raster.bounds;

  map.addSource(sourceId, {
    type: "image",
    url: canvas.toDataURL("image/png"),
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  });
  map.addLayer({
    id,
    type: "raster",
    source: sourceId,
    paint: { "raster-opacity": options.opacity ?? 0.75, "raster-fade-duration": 0 },
  });

  return {
    id,
    sourceId,
    layerId: id,
    bounds: [west, south, east, north],
    remove: () => removeOverlay(map, id, sourceId),
    setVisible: (visible) => {
      try {
        (map as unknown as { setLayoutProperty: (l: string, k: string, v: string) => void })
          .setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      } catch {
        /* the layer may already be gone */
      }
    },
    setOpacity: (opacity) => {
      try {
        (map as unknown as { setPaintProperty: (l: string, k: string, v: number) => void })
          .setPaintProperty(id, "raster-opacity", opacity);
      } catch {
        /* the layer may already be gone */
      }
    },
  };
}

function removeOverlay(map: MapLibreLike, layerId: string, sourceId: string): void {
  try {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  } catch {
    /* ignore */
  }
  try {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  } catch {
    /* ignore */
  }
}

/** Builds a small legend strip for the panel. */
export function renderLegend(ramp: ColourRamp, reverse = false): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 10;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  for (let x = 0; x < canvas.width; x += 1) {
    const t = x / (canvas.width - 1);
    const [r, g, b] = sample(ramp, reverse ? 1 - t : t);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, 0, 1, canvas.height);
  }
  return canvas;
}
