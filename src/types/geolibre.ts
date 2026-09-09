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
  on: (type: string, listener: (event: MapMouseEventLike) => void) => void;
  off: (type: string, listener: (event: MapMouseEventLike) => void) => void;
  getCanvas: () => HTMLCanvasElement;
}

export interface MapMouseEventLike {
  lngLat: { lng: number; lat: number };
  preventDefault?: () => void;
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
  removeLayer?: (layerId: string) => void;
  addLayerGroup?: (name?: string, layerIds?: string[]) => string;
  moveLayersToGroup?: (layerIds: string[], groupId: string | null) => void;

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
