import type {
  GeoJsonFeature,
  GeoJsonFeatureCollection,
  GeoLibreAppAPI,
  MapMouseEventLike,
} from "../types/geolibre";

/**
 * Gathering the origin / destination / barrier geometries the analysis needs.
 *
 * GeoLibre offers several ways to hand features to a plugin — the current
 * selection, the draw tool's output, or an existing layer — and none of them is
 * guaranteed to be present on every host build, so each source is probed and
 * the panel only offers what actually works. Click-to-place is the fallback that
 * needs nothing but the map itself.
 */

export type PointSourceKind = "click" | "selection" | "drawings" | "layer";

export interface PointSet {
  kind: PointSourceKind;
  label: string;
  features: GeoJsonFeature[];
}

export function emptyPointSet(kind: PointSourceKind = "click", label = "None"): PointSet {
  return { kind, label, features: [] };
}

export function toFeatureCollection(features: GeoJsonFeature[]): GeoJsonFeatureCollection {
  return { type: "FeatureCollection", features };
}

/** Serialises for the R engine, giving every feature a stable id column. */
export function pointsToGeoJson(features: GeoJsonFeature[], idPrefix: string): string {
  const withIds = features.map((feature, index) => ({
    ...feature,
    properties: {
      ...(feature.properties ?? {}),
      mcx_id: `${idPrefix}${index + 1}`,
    },
  }));
  return JSON.stringify(toFeatureCollection(withIds));
}

function isPoint(feature: GeoJsonFeature): boolean {
  const type = feature.geometry?.type;
  return type === "Point" || type === "MultiPoint";
}

export function keepPoints(features: GeoJsonFeature[]): GeoJsonFeature[] {
  return features.filter(isPoint);
}

export function keepLinesAndPolygons(features: GeoJsonFeature[]): GeoJsonFeature[] {
  return features.filter((f) => {
    const type = f.geometry?.type ?? "";
    return type.includes("Line") || type.includes("Polygon");
  });
}

/** Reads the host's current selection, if this build exposes one. */
export function readSelection(app: GeoLibreAppAPI): GeoJsonFeature[] {
  try {
    return app.getSelectedFeatures?.() ?? [];
  } catch {
    return [];
  }
}

/** Reads whatever the draw tools currently hold. */
export function readDrawings(app: GeoLibreAppAPI): GeoJsonFeature[] {
  try {
    return app.getDrawnFeatures?.() ?? [];
  } catch {
    return [];
  }
}

export function readLayer(app: GeoLibreAppAPI, layerId: string): GeoJsonFeature[] {
  try {
    return app.getLayerFeatures?.(layerId) ?? [];
  } catch {
    return [];
  }
}

export function listVectorLayers(app: GeoLibreAppAPI) {
  try {
    return app.listLayers?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * Puts the map into click-to-place mode until `stop()` is called.
 *
 * Returns null when the host will not hand over the MapLibre instance, so the
 * caller can hide the button rather than offer something that does nothing.
 */
export function startPointPicking(
  app: GeoLibreAppAPI,
  onPoint: (lng: number, lat: number) => void,
): { stop: () => void } | null {
  const map = app.getMap?.() ?? null;
  if (!map) return null;

  const handler = (event: MapMouseEventLike) => {
    event.preventDefault?.();
    onPoint(event.lngLat.lng, event.lngLat.lat);
  };

  map.on("click", handler);
  let cursor = "";
  try {
    const canvas = map.getCanvas();
    cursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
  } catch {
    /* styling the cursor is a nicety, not a requirement */
  }

  return {
    stop: () => {
      map.off("click", handler);
      try {
        map.getCanvas().style.cursor = cursor;
      } catch {
        /* ignore */
      }
    },
  };
}

export function makePointFeature(lng: number, lat: number, id: string): GeoJsonFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: { mcx_id: id },
  };
}

export function keepPolygons(features: GeoJsonFeature[]): GeoJsonFeature[] {
  return features.filter((f) => (f.geometry?.type ?? "").includes("Polygon"));
}

/** Turns the map's current view into a polygon, for downloading elevation. */
export function viewportPolygon(
  app: GeoLibreAppAPI,
): { feature: GeoJsonFeature; bounds: [number, number, number, number] } | null {
  let bounds: [number, number, number, number] | null = null;
  try {
    bounds = app.getViewBounds?.() ?? null;
  } catch {
    bounds = null;
  }
  if (!bounds) return null;
  const [west, south, east, north] = bounds;
  return {
    bounds,
    feature: {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      },
      properties: { mcx_id: "view" },
    },
  };
}

/** Bounding box of a feature collection, for `fitBounds`. */
export function boundsOf(features: GeoJsonFeature[]): [number, number, number, number] | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const [x, y] = coords as [number, number];
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
      return;
    }
    for (const child of coords) visit(child);
  };

  for (const feature of features) visit(feature.geometry?.coordinates);
  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  return [west, south, east, north];
}

/** Merges two bounding boxes, ignoring nulls. */
export function unionBounds(
  a: [number, number, number, number] | null,
  b: [number, number, number, number] | null,
): [number, number, number, number] | null {
  if (!a) return b;
  if (!b) return a;
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}
