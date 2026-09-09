import "./styles.css";
import { MovecostPanel } from "./ui/panel";
import type {
  GeoLibreAppAPI,
  GeoLibrePlugin,
  MapControl,
  MapControlPosition,
} from "./types/geolibre";

const PLUGIN_ID = "movecost";
const PANEL_ID = "movecost-panel";
const VERSION = "0.1.3";

/**
 * A map-corner button that opens the workspace panel.
 *
 * `registerRightPanel` is optional in the host API, so this control is also the
 * fallback surface: on a host without right panels it opens the same UI in a
 * floating card attached to the map container.
 */
class MovecostControl implements MapControl {
  private container: HTMLElement | null = null;

  constructor(private readonly onToggle: () => void) {}

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group mcx-ctrl";

    const button = document.createElement("button");
    button.type = "button";
    button.title = "movecost — least-cost analysis";
    button.setAttribute("aria-label", "movecost — least-cost analysis");
    button.className = "mcx-ctrl__button";
    button.innerHTML = ICON_SVG;
    button.addEventListener("click", this.onToggle);

    container.append(button);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
  }

  getDefaultPosition(): MapControlPosition {
    return "top-right";
  }
}

/** A path climbing a contour — the plugin's mark in the map toolbar. */
const ICON_SVG = `
<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
     stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2 18c3.5 0 4-9 7.5-9S13 18 16.5 18 20 12 22 12" />
  <circle cx="4" cy="18" r="1.6" fill="currentColor" stroke="none" />
  <circle cx="20" cy="12.6" r="1.6" fill="currentColor" stroke="none" />
</svg>`;

let panel: MovecostPanel | null = null;
let control: MovecostControl | null = null;
let unregisterPanel: (() => void) | null = null;
let unregisterMenu: (() => void) | null = null;
let floating: HTMLElement | null = null;
let panelOpen = false;

function openPanel(app: GeoLibreAppAPI): void {
  if (app.openRightPanel?.(PANEL_ID)) {
    panelOpen = true;
    return;
  }
  mountFloating(app);
}

function closePanel(app: GeoLibreAppAPI): void {
  app.closeRightPanel?.(PANEL_ID);
  unmountFloating();
  panelOpen = false;
}

function togglePanel(app: GeoLibreAppAPI): void {
  if (panelOpen) closePanel(app);
  else openPanel(app);
}

/**
 * Fallback UI for hosts without the right-panel API: a draggable-free card
 * pinned over the map. Deliberately plain — the supported path is the docked
 * panel, and this exists so the plugin is never a dead button.
 */
function mountFloating(app: GeoLibreAppAPI): void {
  if (floating) return;
  const map = app.getMap?.();
  const host = map ? map.getCanvas().parentElement : document.body;
  if (!host) return;

  const card = document.createElement("div");
  card.className = "mcx-floating";
  const header = document.createElement("div");
  header.className = "mcx-floating__header";
  header.textContent = "movecost";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "mcx-floating__close";
  close.textContent = "×";
  close.addEventListener("click", () => closePanel(app));
  header.append(close);

  const body = document.createElement("div");
  body.className = "mcx-floating__body";

  card.append(header, body);
  host.append(card);
  floating = card;
  panelOpen = true;

  panel ??= new MovecostPanel(app);
  panel.mount(body);
}

function unmountFloating(): void {
  floating?.remove();
  floating = null;
}

const plugin: GeoLibrePlugin = {
  id: PLUGIN_ID,
  name: "movecost — least-cost analysis",
  version: VERSION,

  activate(app: GeoLibreAppAPI) {
    panel = new MovecostPanel(app);

    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: "movecost",
        dock: "replace-style",
        defaultWidth: 360,
        render: (container) => panel!.mount(container),
        onOpen: () => {
          panelOpen = true;
        },
        onClose: () => {
          panelOpen = false;
        },
      }) ?? null;

    control = new MovecostControl(() => togglePanel(app));
    app.addMapControl(control, "top-right");

    unregisterMenu =
      app.registerToolbarMenu?.({
        id: "movecost-menu",
        label: "movecost",
        items: [
          {
            type: "action",
            id: "movecost-open",
            label: "Open the movecost panel",
            onSelect: () => openPanel(app),
          },
        ],
      }) ?? null;

    return true;
  },

  deactivate(app: GeoLibreAppAPI) {
    unmountFloating();
    if (control) {
      app.removeMapControl(control);
      control = null;
    }
    unregisterMenu?.();
    unregisterMenu = null;
    unregisterPanel?.();
    unregisterPanel = null;
    app.unregisterRightPanel?.(PANEL_ID);
    panel?.dispose();
    panel = null;
    panelOpen = false;
  },
};

/** `MovecostPanel` is exported for the headless host-layer test only. */
export { plugin, MovecostPanel };
export default plugin;
