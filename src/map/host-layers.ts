import type { DecodedRaster, RenderOptions } from "./raster-overlay";
import { addRasterOverlay, renderRasterToCanvas } from "./raster-overlay";
import { boundsOf } from "./points";
import type {
  ExternalNativeLayerRegistration,
  GeoJsonFeature,
  GeoJsonFeatureCollection,
  GeoLibreAppAPI,
  HostLayerStyle,
  MapLibreLike,
} from "../types/geolibre";

/**
 * Layers the plugin puts on the map, as first-class GeoLibre layers.
 *
 * Everything here goes through `registerExternalNativeLayer`, so each layer
 * shows in the Layers panel, sits in a group, can be hidden, restyled or
 * removed there, and survives the host's own layer syncs. That last point is
 * the one that bit: a layer added straight through `getMap().addLayer()` is
 * unknown to GeoLibre's layer store, which then treats it as part of the
 * basemap — pinning its opacity and visibility to the basemap's — and that is
 * how the cost rasters ended up invisible.
 *
 * Every function degrades: on a host without `registerExternalNativeLayer`
 * the vector layers fall back to `addGeoJsonLayer` (unstyled, not removable)
 * and the rasters to a raw MapLibre overlay.
 */

export interface HostLayerHandle {
  id: string;
  name: string;
  bounds: [number, number, number, number] | null;
  remove: () => void;
  setVisible: (visible: boolean) => void;
  setOpacity: (opacity: number) => void;
}

export function hostOwnsLayers(app: GeoLibreAppAPI): boolean {
  return typeof app.registerExternalNativeLayer === "function";
}

let layerSeq = 0;

/** Store ids must be unique for the life of the project, not just the session. */
export function uniqueLayerId(prefix: string): string {
  layerSeq += 1;
  return `movecost-${prefix}-${Date.now().toString(36)}-${layerSeq}`;
}

/** Removes any store layer by id — see the note on `unregisterExternalNativeLayer`. */
export function removeHostLayer(app: GeoLibreAppAPI, id: string): void {
  try {
    if (app.unregisterExternalNativeLayer) app.unregisterExternalNativeLayer(id);
    else app.removeLayer?.(id);
  } catch {
    /* the layer may already be gone */
  }
}

// --- vector layers -----------------------------------------------------------

export interface HostVectorLayerOptions {
  id?: string;
  name: string;
  features: GeoJsonFeature[];
  style?: Partial<HostLayerStyle>;
  groupId?: string;
}

/**
 * Adds (or, with an id that already exists, refreshes) a GeoJSON layer with a
 * host style. Refreshing keeps whatever the user changed in the Style panel
 * for keys the style here does not set, and keeps the layer's group.
 */
export function addHostVectorLayer(
  app: GeoLibreAppAPI,
  options: HostVectorLayerOptions,
): HostLayerHandle | null {
  const id = options.id ?? uniqueLayerId("vector");
  const collection: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: options.features,
  };
  const bounds = boundsOf(options.features);

  if (!app.registerExternalNativeLayer) {
    let hostId: string | null = null;
    try {
      hostId = app.addGeoJsonLayer(options.name, collection);
    } catch {
      return null;
    }
    const fallbackId = hostId;
    return {
      id: fallbackId,
      name: options.name,
      bounds,
      remove: () => removeHostLayer(app, fallbackId),
      setVisible: () => {
        /* no host API for this without registration */
      },
      setOpacity: () => {
        /* no host API for this without registration */
      },
    };
  }

  const registration: ExternalNativeLayerRegistration = {
    id,
    name: options.name,
    type: "geojson",
    nativeLayerIds: [],
    geojson: collection,
    style: options.style,
    groupId: options.groupId,
    metadata: { movecost: true },
  };
  app.registerExternalNativeLayer(registration);

  return {
    id,
    name: options.name,
    bounds,
    remove: () => removeHostLayer(app, id),
    // The registration API has no visibility flag, so hiding is removing and
    // showing is registering again; the user's Layers-panel eye icon is the
    // better control and this is only used to clear transient markers.
    setVisible: (visible) => {
      if (visible) app.registerExternalNativeLayer?.(registration);
      else removeHostLayer(app, id);
    },
    setOpacity: (opacity) => {
      app.registerExternalNativeLayer?.({ ...registration, opacity });
    },
  };
}

// --- raster (image overlay) layers -------------------------------------------

export interface HostRasterLayerOptions extends RenderOptions {
  id?: string;
  name: string;
  groupId?: string;
}

/**
 * Paints a decoded engine raster to a canvas and hands it to the host as a
 * georeferenced image overlay — the same layer type its Raster Georeferencer
 * produces — so the Layers panel's opacity slider and visibility toggle drive
 * it natively. The colour ramp is baked into the image; changing the ramp
 * means re-adding the layer.
 */
export function addHostRasterLayer(
  app: GeoLibreAppAPI,
  raster: DecodedRaster,
  options: HostRasterLayerOptions,
): HostLayerHandle | null {
  const { west, south, east, north } = raster.bounds;
  const bounds: [number, number, number, number] = [west, south, east, north];
  const opacity = options.opacity ?? 0.75;

  if (!app.registerExternalNativeLayer) {
    const overlay = addRasterOverlay(app, raster, options);
    if (!overlay) return null;
    return {
      id: overlay.id,
      name: options.name,
      bounds,
      remove: overlay.remove,
      setVisible: overlay.setVisible,
      setOpacity: overlay.setOpacity,
    };
  }

  // Full alpha in the image; the host applies the layer opacity itself, so
  // the slider in the Layers panel starts from the value we register.
  const canvas = renderRasterToCanvas(raster, { ...options, opacity: 1 });
  const url = canvas.toDataURL("image/png");
  const id = options.id ?? uniqueLayerId("raster");
  const registration: ExternalNativeLayerRegistration = {
    id,
    name: options.name,
    type: "image",
    nativeLayerIds: [],
    source: {
      type: "image",
      url,
      coordinates: [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ],
    },
    opacity,
    groupId: options.groupId,
    metadata: { movecost: true, movecostRange: [raster.min, raster.max] },
  };
  app.registerExternalNativeLayer(registration);

  return {
    id,
    name: options.name,
    bounds,
    remove: () => removeHostLayer(app, id),
    setVisible: (visible) => {
      if (visible) app.registerExternalNativeLayer?.(registration);
      else removeHostLayer(app, id);
    },
    setOpacity: (value) => {
      app.registerExternalNativeLayer?.({ ...registration, opacity: value });
    },
  };
}

// --- groups ------------------------------------------------------------------

/**
 * Puts layers into a named group, creating it on first use. Returns the group
 * id to pass back next time. A group the user deleted in the meantime makes
 * `moveLayersToGroup` a silent no-op, so the layers then simply stay at the top
 * level rather than vanishing into a ghost group.
 */
export function groupHostLayers(
  app: GeoLibreAppAPI,
  name: string,
  layerIds: string[],
  existingGroupId: string | null,
  options: { volatile?: boolean } = {},
): string | null {
  if (!layerIds.length) return existingGroupId;
  try {
    // A "volatile" group is one whose members get removed and registered again
    // — the markers, which are re-added to stay above a run's rasters. Without
    // `moveLayersToGroup` a group can only be filled at the moment it is
    // created, so the first re-add empties it and nothing can ever put a layer
    // back in: one dead row in the Layers panel for the rest of the session.
    // Better to leave those layers ungrouped on such a host.
    if (options.volatile && typeof app.moveLayersToGroup !== "function") return null;
    // One group per name, for the life of the panel. A host without
    // `moveLayersToGroup` used to fall through to `addLayerGroup` on every
    // call, and since the layers follow the new group the old one is left
    // empty — a session ends with twenty empty "movecost · locations" rows in
    // the Layers panel. Reusing the group we have costs nothing worse than
    // markers that stay ungrouped on such a host.
    if (existingGroupId) {
      app.moveLayersToGroup?.(layerIds, existingGroupId);
      return existingGroupId;
    }
    if (app.addLayerGroup) return app.addLayerGroup(name, layerIds) ?? null;
  } catch {
    /* grouping is cosmetic */
  }
  return existingGroupId;
}

// --- raw-map marker fallback ---------------------------------------------------

/**
 * Click feedback on a host that cannot register layers: a plain circle layer
 * straight on the MapLibre map. Invisible to the Layers panel, but it does show
 * the user where they clicked.
 */
export function addRawMarkerLayer(
  map: MapLibreLike,
  id: string,
  features: GeoJsonFeature[],
  colour: string,
): () => void {
  const sourceId = `${id}-source`;
  const data: GeoJsonFeatureCollection = { type: "FeatureCollection", features };
  const source = map.getSource(sourceId) as { setData?: (d: unknown) => void } | undefined;
  if (source?.setData) {
    source.setData(data);
  } else {
    map.addSource(sourceId, { type: "geojson", data });
    map.addLayer({
      id,
      type: "circle",
      source: sourceId,
      paint: {
        "circle-radius": 7,
        "circle-color": colour,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
  }
  return () => {
    try {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    } catch {
      /* ignore */
    }
  };
}
