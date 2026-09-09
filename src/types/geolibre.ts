/**
 * A structural subset of GeoLibre's host API.
 *
 * The real definitions live in `packages/plugins/src/types.ts` inside the
 * GeoLibre repository, but an external plugin must not import from the host at
 * runtime (the bundle has to be self-contained), so the members this plugin
 * actually touches are re-declared here. Everything the host types as optional
 * stays optional: older or slimmer hosts genuinely do not provide it, and every
 * call site uses optional chaining with a fallback.
 */

export type GeoJsonGeometry = {
  type: string;
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
};

export interface GeoJsonFeature {
  type: "Feature";
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> | null;
  id?: string | number;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

export type MapControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface MapControl {
  onAdd: (map: unknown) => HTMLElement;
  onRemove: () => void;
  getDefaultPosition?: () => MapControlPosition;
}

export interface GeoLibreLayerSummary {
  id: string;
  name?: string;
  type?: string;
}

export interface RightPanelRegistration {
  id: string;
  title: string | (() => string);
  dock?:
    | "left-of-layers"
    | "right-of-layers"
    | "left-of-style"
    | "right-of-style"
    | "replace-style"
    | "replace-layers";
  icon?: string;
  defaultWidth?: number;
  deactivatePluginOnClose?: boolean;
  render: (container: HTMLElement) => void | (() => void);
  onOpen?: () => void;
  onClose?: () => void;
}

export interface ToolbarMenuItem {
  type?: "action" | "separator" | "submenu";
  id?: string;
  label?: string | (() => string);
  disabled?: boolean | (() => boolean);
  onSelect?: () => void;
  items?: ToolbarMenuItem[];
}

export interface ToolbarMenu {
  id: string;
  label: string | (() => string);
  icon?: string;
  items: ToolbarMenuItem[];
}

/**
 * The minimal MapLibre surface the plugin uses for the raster overlay. Kept
 * loose on purpose — the host owns the real map instance and its version.
 */
export interface MapLibreLike {
  addSource: (id: string, source: Record<string, unknown>) => void;
  removeSource: (id: string) => void;
  getSource: (id: string) => unknown;
  addLayer: (layer: Record<string, unknown>, before?: string) => void;
  removeLayer: (id: string) => void;
  getLayer: (id: string) => unknown;
  setLayoutProperty?: (layerId: string, name: string, value: unknown) => void;
  setPaintProperty?: (layerId: string, name: string, value: unknown) => void;
  getLayoutProperty?: (layerId: string, name: string) => unknown;
  getPaintProperty?: (layerId: string, name: string) => unknown;
  moveLayer?: (layerId: string, beforeId?: string) => void;
  getLayersOrder?: () => string[];
  getBounds?: () => { toArray?: () => [[number, number], [number, number]] } | null;
  on: (type: string, listener: (event: MapMouseEventLike) => void) => void;
  off: (type: string, listener: (event: MapMouseEventLike) => void) => void;
  getCanvas: () => HTMLCanvasElement;
}

export interface MapMouseEventLike {
  lngLat: { lng: number; lat: number };
  preventDefault?: () => void;
}

/**
 * The subset of GeoLibre's `LayerStyle` this plugin sets. The host merges a
 * partial over its defaults (`DEFAULT_LAYER_STYLE` in `@geolibre/core`), so
 * only the keys that differ from those defaults need declaring.
 */
export interface HostLayerStyle {
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  fillOpacity: number;
  circleRadius: number;
  markerEnabled: boolean;
  markerShape: "circle" | "square" | "triangle" | "diamond" | "star" | "cross" | "pin";
  markerColor: string;
  markerSize: number;
  lineDecoration: "none" | "arrow" | "triangle" | "circle" | "square";
  lineDecorationColor: string;
  lineDecorationSize: number;
  lineDecorationSpacing: number;
  labels: Partial<{
    enabled: boolean;
    field: string;
    size: number;
    color: string;
    haloColor: string;
    haloWidth: number;
    allowOverlap: boolean;
    anchor: "center" | "top" | "bottom" | "left" | "right";
    offsetX: number;
    offsetY: number;
  }>;
}

/**
 * `registerExternalNativeLayer` mirrors a layer into GeoLibre's layer store so
 * it shows in the Layers panel, can be grouped, restyled and removed there,
 * and persists with the project.
 *
 * The documented use is a layer the plugin already added to the map itself
 * (`nativeLayerIds` non-empty). With an EMPTY `nativeLayerIds` the host does
 * not treat the layer as external at all and renders it through its own
 * pipeline from `type` + `source`/`geojson` — a plain GeoJSON layer with a host
 * `style`, or a georeferenced `image` overlay from a data URL — which is what
 * lets a plugin create fully host-owned layers with a chosen style. Verified
 * against GeoLibre 2.9.0 (`packages/map/src/layer-sync.ts`).
 */
export interface ExternalNativeLayerRegistration {
  id: string;
  name: string;
  groupId?: string;
  type?: "geojson" | "raster" | "image";
  source?: Record<string, unknown>;
  geojson?: GeoJsonFeatureCollection;
  nativeLayerIds: string[];
  sourceIds?: string[];
  sourceId?: string;
  beforeId?: string;
  opacity?: number;
  style?: Partial<HostLayerStyle>;
  metadata?: Record<string, unknown>;
  paintMode?: "geolibre" | "plugin";
}

export interface GeoLibreAppAPI {
  addGeoJsonLayer: (
    name: string,
    data: GeoJsonFeatureCollection,
    sourcePath?: string,
  ) => string;
  addMapControl: (control: MapControl, position?: MapControlPosition) => boolean;
  removeMapControl: (control: MapControl) => void;

  listLayers?: () => GeoLibreLayerSummary[];
  getLayerFeatures?: (layerId: string) => GeoJsonFeature[];
  getSelectedFeatures?: () => GeoJsonFeature[];
  getDrawnFeatures?: () => GeoJsonFeature[];
  /** Not part of the public API today; kept optional in case a host adds it. */
  removeLayer?: (layerId: string) => void;
  registerExternalNativeLayer?: (layer: ExternalNativeLayerRegistration) => void;
  /**
   * Removes a layer from the host's store by id. The host implementation
   * (`usePlugins.ts`) removes ANY store layer with that id, so this is also the
   * only way for a plugin to remove a layer it added with `addGeoJsonLayer`.
   */
  unregisterExternalNativeLayer?: (id: string) => void;
  addLayerGroup?: (name?: string, layerIds?: string[]) => string;
  moveLayersToGroup?: (layerIds: string[], groupId: string | null) => void;
  removeLayerGroup?: (id: string) => void;

  fitBounds?: (bounds: [number, number, number, number]) => void;
  getViewBounds?: () => [number, number, number, number] | null;
  getMap?: () => MapLibreLike | null;

  pickLocalDirectoryFiles?: () => Promise<File[] | null>;
  resolvePluginAssetUrl?: (pluginId: string, relativePath: string) => string | null;
  exportTextFile?: (filename: string, content: string) => void;

  registerRightPanel?: (panel: RightPanelRegistration) => () => void;
  unregisterRightPanel?: (id: string) => void;
  openRightPanel?: (id: string) => boolean;
  closeRightPanel?: (id: string) => void;
  registerToolbarMenu?: (menu: ToolbarMenu) => () => void;
}

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activate: (app: GeoLibreAppAPI) => boolean | void | Promise<boolean | void>;
  deactivate: (app: GeoLibreAppAPI) => void;
  getProjectState?: () => unknown;
  applyProjectState?: (app: GeoLibreAppAPI, state: unknown) => boolean | void;
}
