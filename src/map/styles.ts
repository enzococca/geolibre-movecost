import type { HostLayerStyle } from "../types/geolibre";

/**
 * How the plugin's layers look in GeoLibre.
 *
 * Origins and destinations must be told apart at a glance, so they differ in
 * both shape and colour: origins are green circles, destinations red
 * triangles, and both carry the id the engine will use (O1, D1, …) as a label
 * so the cost table in the results can be read back against the map.
 */

export const ORIGIN_STYLE: Partial<HostLayerStyle> = {
  fillColor: "#16a34a",
  fillOpacity: 1,
  strokeColor: "#ffffff",
  strokeWidth: 2,
  circleRadius: 8,
  markerEnabled: false,
  labels: {
    enabled: true,
    field: "mcx_id",
    size: 13,
    color: "#14532d",
    haloColor: "#ffffff",
    haloWidth: 2.5,
    anchor: "top",
    offsetY: 0.9,
    allowOverlap: true,
  },
};

export const DESTINATION_STYLE: Partial<HostLayerStyle> = {
  fillColor: "#dc2626",
  fillOpacity: 1,
  strokeColor: "#ffffff",
  strokeWidth: 2,
  circleRadius: 8,
  markerEnabled: true,
  markerShape: "triangle",
  markerColor: "#dc2626",
  markerSize: 22,
  labels: {
    enabled: true,
    field: "mcx_id",
    size: 13,
    color: "#7f1d1d",
    haloColor: "#ffffff",
    haloWidth: 2.5,
    anchor: "top",
    offsetY: 1.1,
    allowOverlap: true,
  },
};

/** Barriers are drawn faintly: they are the user's own features, only echoed. */
export const BARRIER_STYLE: Partial<HostLayerStyle> = {
  fillColor: "#334155",
  fillOpacity: 0.15,
  strokeColor: "#0f172a",
  strokeWidth: 2,
};

const RESULT_STYLES: Record<string, Partial<HostLayerStyle>> = {
  lcps: { strokeColor: "#e11d48", strokeWidth: 3, lineDecoration: "arrow", lineDecorationColor: "#e11d48" },
  lcpsBack: { strokeColor: "#f97316", strokeWidth: 2, lineDecoration: "arrow", lineDecorationColor: "#f97316" },
  lcpAtoB: { strokeColor: "#e11d48", strokeWidth: 3, lineDecoration: "arrow", lineDecorationColor: "#e11d48" },
  lcpBtoA: { strokeColor: "#f97316", strokeWidth: 2, lineDecoration: "arrow", lineDecorationColor: "#f97316" },
  rankedPaths: { strokeColor: "#7c3aed", strokeWidth: 2.5 },
  network: { strokeColor: "#7c3aed", strokeWidth: 2.5 },
  isolines: { strokeColor: "#1d4ed8", strokeWidth: 1.5 },
  boundaries: { fillColor: "#f59e0b", fillOpacity: 0.25, strokeColor: "#b45309", strokeWidth: 1.5 },
  destinations: { fillColor: "#dc2626", fillOpacity: 1, strokeColor: "#ffffff", circleRadius: 6 },
  origins: { fillColor: "#16a34a", fillOpacity: 1, strokeColor: "#ffffff", circleRadius: 6 },
};

const KIND_STYLES: Record<string, Partial<HostLayerStyle>> = {
  line: { strokeColor: "#e11d48", strokeWidth: 2.5 },
  polygon: { fillColor: "#f59e0b", fillOpacity: 0.25, strokeColor: "#b45309", strokeWidth: 1.5 },
  point: { fillColor: "#0f766e", fillOpacity: 1, strokeColor: "#ffffff", circleRadius: 6 },
};

export function resultStyle(key: string, kind: string): Partial<HostLayerStyle> {
  return RESULT_STYLES[key] ?? KIND_STYLES[kind] ?? {};
}
