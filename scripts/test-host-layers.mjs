#!/usr/bin/env node
// =============================================================================
// Headless check of the plugin's map integration against a mock GeoLibre host.
//
//   node scripts/test-host-layers.mjs        (after `npm run build`)
//
// Loads dist/index.js in Chromium with a fake `app` that records every call to
// registerExternalNativeLayer / unregisterExternalNativeLayer / addLayerGroup /
// moveLayersToGroup, then drives the panel: places origin and destination
// points through the map click handler, checks the marker layers and their
// styles, feeds a fake analysis response through the results path, and checks
// the rasters arrive as host `image` layers grouped with the vectors.
// =============================================================================

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bundle = readFileSync(resolve("dist/index.js"), "utf8");
const css = readFileSync(resolve("dist/style.css"), "utf8");

const browser = await chromium.launch({ executablePath: process.env.MCX_CHROMIUM || undefined });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page error:", e.message));

await page.setContent(`<!doctype html><html><body>
<div id="map"><canvas id="c"></canvas></div><div id="panel"></div>
<style>${css}</style></body></html>`);

const results = await page.evaluate(async (bundleSource) => {
  const calls = [];
  const store = new Map();
  const groups = [];
  const handlers = {};
  const fakeMap = {
    on: (t, h) => ((handlers[t] ??= []).push(h)),
    off: (t, h) => (handlers[t] = (handlers[t] ?? []).filter((x) => x !== h)),
    getCanvas: () => document.getElementById("c"),
    addSource() {}, removeSource() {}, getSource: () => null,
    addLayer() {}, removeLayer() {}, getLayer: () => null,
  };
  let panelRender = null;
  const app = {
    addGeoJsonLayer: (name) => { calls.push(["addGeoJsonLayer", name]); return `gj-${name}`; },
    addMapControl: () => true,
    removeMapControl() {},
    listLayers: () => [...store.values()].map((l) => ({ id: l.id, name: l.name, type: l.type })),
    getMap: () => fakeMap,
    fitBounds: (b) => calls.push(["fitBounds", b]),
    registerExternalNativeLayer: (reg) => {
      calls.push(["register", reg.id, reg.type, reg.name, Boolean(store.has(reg.id))]);
      const existing = store.get(reg.id);
      store.set(reg.id, { ...(existing ?? {}), ...reg, groupId: reg.groupId ?? existing?.groupId });
    },
    unregisterExternalNativeLayer: (id) => { calls.push(["unregister", id]); store.delete(id); },
    addLayerGroup: (name, ids) => {
      const id = `group-${groups.length + 1}`;
      groups.push({ id, name, ids: [...ids] });
      for (const lid of ids) if (store.has(lid)) store.get(lid).groupId = id;
      calls.push(["addLayerGroup", name, ids]);
      return id;
    },
    moveLayersToGroup: (ids, gid) => {
      calls.push(["moveLayersToGroup", ids, gid]);
      const g = groups.find((x) => x.id === gid);
      for (const lid of ids) {
        if (g && !g.ids.includes(lid)) g.ids.push(lid);
        if (store.has(lid)) store.get(lid).groupId = gid;
      }
    },
    registerRightPanel: (p) => { panelRender = p.render; return () => {}; },
    openRightPanel: () => true,
  };

  const blob = new Blob([bundleSource], { type: "text/javascript" });
  const mod = await import(URL.createObjectURL(blob));
  const plugin = mod.plugin ?? mod.default;
  plugin.activate(app);
  panelRender(document.getElementById("panel"));
  await new Promise((r) => setTimeout(r, 50));

  const clickButton = (label) => {
    const b = [...document.querySelectorAll("#panel button")].find((x) => x.textContent.trim() === label);
    if (!b) throw new Error(`no button "${label}"`);
    b.click();
  };
  const fireClick = (lng, lat) => {
    for (const h of [...(handlers.click ?? [])]) h({ lngLat: { lng, lat }, preventDefault() {} });
  };

  // --- origin: one click, then a second click replaces it (max 1 for "paths")
  clickButton("Click on the map");
  fireClick(14.4, 40.8);
  await new Promise((r) => setTimeout(r, 10));
  const originAfterFirst = structuredClone(store.get("movecost-origin"));
  fireClick(14.5, 40.9);
  clickButton("Stop placing");

  // --- destinations: two clicks
  const destButtons = [...document.querySelectorAll("#panel button")].filter((x) => x.textContent.trim() === "Click on the map");
  destButtons[destButtons.length - 1].click();
  fireClick(14.6, 40.7);
  fireClick(14.7, 40.6);
  clickButton("Stop placing");

  const snapshot = () => JSON.parse(JSON.stringify([...store.values()].map((l) => ({
    id: l.id, type: l.type, name: l.name, groupId: l.groupId, n: l.geojson?.features?.length,
    ids: l.geojson?.features?.map((f) => f.properties.mcx_id),
    style: l.style, source: l.source ? { type: l.source.type, url: String(l.source.url).slice(0, 22), coordinates: l.source.coordinates } : undefined,
    opacity: l.opacity,
  }))));
  const afterMarkers = snapshot();

  // --- results: feed a fake response through the private results path
  const width = 4, height = 3;
  const f32 = new Float32Array(width * height).map((_, i) => (i === 5 ? NaN : i));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(f32.buffer)));
  const raster = { name: "accumulated", width, height, data: b64, bounds: { west: 14.3, south: 40.5, east: 14.8, north: 41.0 }, min: 0, max: 11 };
  const line = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[14.4, 40.8], [14.6, 40.7]] }, properties: { cost: 1.2 } }] });
  const response = { ok: true, analysis: "paths", crs: "EPSG:32633", elapsedSeconds: 1.5, result: { vectors: { lcps: line, isolines: line }, rasters: { accumulated: raster, costSurface: raster }, tables: {} }, log: [] };

  // The bundle exports the panel class for exactly this: drive the results
  // path directly (TypeScript's `private` is compile-time only).
  let addResultsOk = false;
  let produced = null;
  if (mod.MovecostPanel) {
    const p = new mod.MovecostPanel(app);
    p.addResultsToMap(response);
    addResultsOk = true;
    produced = p.produced.map((x) => [x.label, x.kind, x.handle.id]);
    p.produced.find((x) => x.kind === "raster").handle.setOpacity(0.4);
    p.clearProduced();
  }
  const afterResults = snapshot();

  return { calls, groups, originAfterFirst: originAfterFirst && { n: originAfterFirst.geojson.features.length, ids: originAfterFirst.geojson.features.map((f) => f.properties.mcx_id) }, afterMarkers, addResultsOk, produced, afterResults };
}, bundle);

// --- fallback host: no layer registry, a MapLibre map that fights back --------
const fallback = await page.evaluate(async (bundleSource) => {
  const layers = new Map();
  const sources = new Map();
  const listeners = {};
  const fire = (t) => { for (const h of [...(listeners[t] ?? [])]) h({}); };
  const map = {
    on: (t, h) => ((listeners[t] ??= []).push(h)),
    off: (t, h) => (listeners[t] = (listeners[t] ?? []).filter((x) => x !== h)),
    getCanvas: () => document.getElementById("c"),
    addSource: (id, src) => { sources.set(id, src); },
    removeSource: (id) => sources.delete(id),
    getSource: (id) => sources.get(id) ?? null,
    addLayer: (l) => { layers.set(l.id, { ...l, layout: { ...(l.layout ?? {}) }, paint: { ...(l.paint ?? {}) } }); fire("styledata"); },
    removeLayer: (id) => { layers.delete(id); },
    getLayer: (id) => layers.get(id) ?? null,
    getLayoutProperty: (id, k) => layers.get(id)?.layout[k],
    getPaintProperty: (id, k) => layers.get(id)?.paint[k],
    setLayoutProperty: (id, k, v) => { layers.get(id).layout[k] = v; fire("styledata"); },
    setPaintProperty: (id, k, v) => { layers.get(id).paint[k] = v; fire("styledata"); },
    getLayersOrder: () => [...layers.keys()],
    moveLayer: (id) => { const l = layers.get(id); layers.delete(id); layers.set(id, l); fire("styledata"); },
  };
  const app = {
    addGeoJsonLayer: (name) => `gj-${name}`,
    addMapControl: () => true, removeMapControl() {},
    getMap: () => map,
    registerRightPanel: () => () => {},
  };
  const mod = await import(URL.createObjectURL(new Blob([bundleSource], { type: "text/javascript" })));
  const p = new mod.MovecostPanel(app);
  const width = 4, height = 3;
  const f32 = new Float32Array(width * height).map((_, i) => i);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(f32.buffer)));
  const raster = { name: "accumulated", width, height, data: b64, bounds: { west: 14.3, south: 40.5, east: 14.8, north: 41.0 }, min: 0, max: 11 };
  const response = { ok: true, analysis: "paths", crs: "EPSG:32633", elapsedSeconds: 1, result: { vectors: {}, rasters: { accumulated: raster }, tables: {} }, log: [] };
  p.addResultsToMap(response);
  const id = [...layers.keys()].find((k) => k.startsWith("movecost-raster"));
  const initialOpacity = layers.get(id).paint["raster-opacity"];

  // 1. The host's basemap pass pins opacity and hides the layer.
  layers.get(id).paint["raster-opacity"] = 0.1;
  layers.get(id).layout.visibility = "none";
  map.addLayer({ id: "host-fill", type: "fill", source: "x" }); // a sync pass adds a layer on top
  const healed = { opacity: layers.get(id).paint["raster-opacity"], visibility: layers.get(id).layout.visibility, onTop: [...layers.keys()].pop() === id };

  // 2. A basemap change wipes every layer and source.
  layers.clear(); sources.clear();
  fire("style.load");
  const reAdded = { layer: layers.has(id), source: sources.has(`${id}-source`) };

  // 3. remove() stops the watcher.
  p.clearProduced();
  fire("style.load");
  const afterRemove = { layer: layers.has(id), source: sources.has(`${id}-source`) };

  // 4. No map at all: the panel keeps a thumbnail.
  const p2 = new mod.MovecostPanel({ ...app, getMap: () => null });
  p2.addResultsToMap(response);
  const preview = p2.produced[0]?.preview;
  const noMap = { produced: p2.produced.length, handle: p2.produced[0]?.handle, thumb: preview ? [preview.canvas.width, preview.canvas.height, preview.min, preview.max] : null };
  p2.lastRun = { response, layers: p2.produced }; // run() sets this; we bypassed run()
  const host = document.getElementById("panel"); host.innerHTML = "";
  p2.mount(host);
  const thumbOnly = document.querySelectorAll("#panel .mcx-thumb--only canvas").length;

  return { initialOpacity, healed, reAdded, afterRemove, noMap, thumbOnly };
}, bundle);

// --- store-faithful host: layer order after a run ---------------------------
// GeoLibre keeps `layers` bottom-to-top, anchors a group where its first member
// sits (normalizeGroupContiguity) and moves layers into a group right after the
// group's last member (moveLayersToGroup). The markers must end on top of a
// run's rasters under exactly those rules.
const ordering = await page.evaluate(async (bundleSource) => {
  let layers = [];
  const groups = [];
  const normalize = (list) => {
    const out = []; const placed = new Set();
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (placed.has(l.id)) continue;
      if (!l.groupId) { out.push(l); placed.add(l.id); continue; }
      for (let j = i; j < list.length; j++) {
        const c = list[j];
        if (c.groupId === l.groupId && !placed.has(c.id)) { out.push(c); placed.add(c.id); }
      }
    }
    return out;
  };
  const app = {
    addGeoJsonLayer: () => "x", addMapControl: () => true, removeMapControl() {},
    getMap: () => ({ on() {}, off() {}, getCanvas: () => document.getElementById("c"), addSource() {}, removeSource() {}, getSource: () => null, addLayer() {}, removeLayer() {}, getLayer: () => null }),
    registerExternalNativeLayer: (reg) => {
      const i = layers.findIndex((l) => l.id === reg.id);
      if (i >= 0) layers[i] = { ...layers[i], name: reg.name };
      else layers.push({ id: reg.id, name: reg.name, type: reg.type });
    },
    unregisterExternalNativeLayer: (id) => { layers = layers.filter((l) => l.id !== id); },
    addLayerGroup: (name, ids) => {
      const id = "g" + (groups.length + 1); groups.push({ id, name });
      const set = new Set(ids ?? []);
      layers = normalize(layers.map((l) => (set.has(l.id) ? { ...l, groupId: id } : l)));
      return id;
    },
    moveLayersToGroup: (ids, gid) => {
      if (gid && !groups.some((g) => g.id === gid)) return;
      const req = new Set(ids);
      const moving = layers.filter((l) => req.has(l.id) && (l.groupId ?? null) !== gid);
      if (!moving.length) return;
      const mv = new Set(moving.map((l) => l.id));
      const without = layers.filter((l) => !mv.has(l.id));
      let last = -1; without.forEach((l, i) => { if (l.groupId === gid) last = i; });
      const index = last < 0 ? without.length : last + 1;
      const next = [...without]; next.splice(index, 0, ...moving.map((l) => ({ ...l, groupId: gid ?? undefined })));
      layers = normalize(next);
    },
    removeLayerGroup: (id) => { layers = layers.map((l) => (l.groupId === id ? { ...l, groupId: undefined } : l)); },
    listLayers: () => layers.map((l) => ({ id: l.id, name: l.name })),
    registerRightPanel: () => () => {},
  };
  const mod = await import(URL.createObjectURL(new Blob([bundleSource], { type: "text/javascript" })));
  const p = new mod.MovecostPanel(app);
  const pt = (x) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x, x] }, properties: {} });
  p.origin = { kind: "click", label: "x", features: [pt(1)] }; p.refreshMarkers("origin");
  p.destination = { kind: "click", label: "x", features: [pt(2), pt(3)] }; p.refreshMarkers("destination");
  // A terrain layer arrives after the markers: it must end below them.
  const f32 = new Float32Array(12).map((_, i) => i);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(f32.buffer)));
  const raster = { name: "a", width: 4, height: 3, data: b64, bounds: { west: 0, south: 0, east: 1, north: 1 }, min: 0, max: 11 };
  const line = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: {} }] });
  // Two runs, each adding layers above the markers: the panel must raise them
  // both times without leaving an empty group behind either time.
  p.addResultsToMap({ ok: true, analysis: "paths", crs: "EPSG:32633", elapsedSeconds: 1, result: { vectors: { lcps: line }, rasters: { accumulated: raster }, tables: {} }, log: [] });
  p.addResultsToMap({ ok: true, analysis: "paths", crs: "EPSG:32633", elapsedSeconds: 1, result: { vectors: { lcps: line }, rasters: { accumulated: raster }, tables: {} }, log: [] });
  const populated = new Set(layers.map((l) => l.groupId).filter(Boolean));
  return {
    order: layers.map((l) => `${l.id.replace(/-[a-z0-9]+-\d+$/, "")}@${l.groupId}`),
    groups: groups.map((g) => g.name),
    locationGroups: groups.filter((g) => g.name.includes("locations")).length,
    emptyGroups: groups.filter((g) => !populated.has(g.id)).map((g) => g.name),
  };
}, bundle);

// --- a host with no moveLayersToGroup ---------------------------------------
// GeoLibre's newer builds can move layers between groups; older ones cannot,
// and that is the case that filled a user's Layers panel with twenty empty
// "movecost · locations" rows — each raise fell through to addLayerGroup, and
// the layers followed the new group. One group, whatever the host offers.
const noMove = await page.evaluate(async (bundleSource) => {
  let layers = [];
  const groups = [];
  const app = {
    addGeoJsonLayer: () => "x", addMapControl: () => true, removeMapControl() {},
    getMap: () => ({ on() {}, off() {}, getCanvas: () => document.getElementById("c"), addSource() {}, removeSource() {}, getSource: () => null, addLayer() {}, removeLayer() {}, getLayer: () => null }),
    registerExternalNativeLayer: (reg) => {
      const i = layers.findIndex((l) => l.id === reg.id);
      if (i >= 0) layers[i] = { ...layers[i], name: reg.name };
      else layers.push({ id: reg.id, name: reg.name, type: reg.type });
    },
    unregisterExternalNativeLayer: (id) => { layers = layers.filter((l) => l.id !== id); },
    addLayerGroup: (name, ids) => {
      const id = "g" + (groups.length + 1);
      groups.push({ id, name });
      const set = new Set(ids ?? []);
      layers = layers.map((l) => (set.has(l.id) ? { ...l, groupId: id } : l));
      return id;
    },
    // no moveLayersToGroup, no removeLayerGroup
    listLayers: () => layers.map((l) => ({ id: l.id, name: l.name })),
    registerRightPanel: () => () => {},
  };
  const mod = await import(URL.createObjectURL(new Blob([bundleSource], { type: "text/javascript" })));
  const p = new mod.MovecostPanel(app);
  const pt = (x) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x, x] }, properties: {} });
  p.origin = { kind: "click", label: "x", features: [pt(1)] }; p.refreshMarkers("origin");
  p.destination = { kind: "click", label: "x", features: [pt(2)] }; p.refreshMarkers("destination");
  const f32 = new Float32Array(12).map((_, i) => i);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(f32.buffer)));
  const raster = { name: "a", width: 4, height: 3, data: b64, bounds: { west: 0, south: 0, east: 1, north: 1 }, min: 0, max: 11 };
  const line = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: {} }] });
  const response = { ok: true, analysis: "paths", crs: "EPSG:32633", elapsedSeconds: 1, result: { vectors: { lcps: line }, rasters: { accumulated: raster }, tables: {} }, log: [] };
  for (let i = 0; i < 3; i++) p.addResultsToMap(response);
  return { locationGroups: groups.filter((g) => g.name.includes("locations")).length, total: groups.length };
}, bundle);

await browser.close();

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
};

const origin = results.afterMarkers.find((l) => l.id === "movecost-origin");
const dest = results.afterMarkers.find((l) => l.id === "movecost-destination");
check(results.originAfterFirst?.n === 1 && results.originAfterFirst.ids[0] === "O1", "first click registers origin O1", JSON.stringify(results.originAfterFirst));
check(origin && origin.n === 1 && origin.ids[0] === "O1", "second origin click replaces (max 1)", JSON.stringify(origin?.ids));
check(dest && dest.n === 2 && dest.ids.join() === "D1,D2", "two destination clicks give D1, D2", JSON.stringify(dest?.ids));
check(origin?.type === "geojson" && origin.style?.markerEnabled === false && origin.style?.fillColor === "#16a34a", "origin style: green circle", JSON.stringify(origin?.style && { markerEnabled: origin.style.markerEnabled, fillColor: origin.style.fillColor }));
check(dest?.style?.markerEnabled === true && dest.style.markerShape === "triangle" && dest.style.markerColor === "#dc2626", "destination style: red triangle", JSON.stringify(dest?.style && { shape: dest.style.markerShape, color: dest.style.markerColor }));
check(origin?.style?.labels?.enabled && origin.style.labels.field === "mcx_id", "markers are labelled by engine id");
check(origin?.groupId && origin.groupId === dest?.groupId, "origin and destination share the locations group", `${origin?.groupId} / ${dest?.groupId}`);
const inputGroup = results.groups.find((g) => g.name === "movecost · locations");
check(Boolean(inputGroup), "locations group created once", JSON.stringify(results.groups.map((g) => g.name)));
check(results.groups.filter((g) => g.name === "movecost · locations").length === 1, "locations group not duplicated");

if (results.addResultsOk) {
  const rasters = results.afterResults.filter((l) => l.type === "image");
  const vectors = results.afterResults.filter((l) => l.type === "geojson" && !l.id.startsWith("movecost-origin") && !l.id.startsWith("movecost-destination"));
  check(results.produced.length === 4, "four result layers produced", JSON.stringify(results.produced));
  check(rasters.length === 0 && vectors.length === 0, "clearProduced removed all result layers", JSON.stringify(results.afterResults.map((l) => l.id)));
  const runGroup = results.groups.find((g) => g.name.startsWith("movecost · Least-cost paths #1"));
  check(Boolean(runGroup) && runGroup.ids.length === 4, "results grouped per run", JSON.stringify(runGroup));
  const regs = results.calls.filter((c) => c[0] === "register" && c[2] === "image");
  check(regs.length >= 3, "rasters registered as host image layers (incl. opacity re-register)", String(regs.length));
  const order = results.calls.filter((c) => c[0] === "register" && c[1].startsWith("movecost-raster") || c[0] === "register" && c[1].startsWith("movecost-vector")).map((c) => c[2]);
  check(order.slice(0, 2).every((t) => t === "image"), "rasters registered before vectors", order.join(","));
} else {
  check(false, "MovecostPanel export available for the results check");
}

check(fallback.initialOpacity === 0.75, "fallback overlay starts at the panel opacity", String(fallback.initialOpacity));
check(fallback.healed.opacity === 0.75 && fallback.healed.visibility === "visible" && fallback.healed.onTop, "fallback overlay heals opacity, visibility and order after a host pass", JSON.stringify(fallback.healed));
check(fallback.reAdded.layer && fallback.reAdded.source, "fallback overlay re-adds itself after a style reload", JSON.stringify(fallback.reAdded));
check(!fallback.afterRemove.layer && !fallback.afterRemove.source, "removed overlay stays removed", JSON.stringify(fallback.afterRemove));
check(fallback.noMap.produced === 1 && fallback.noMap.handle === null && fallback.noMap.thumb?.[0] === 4, "no map: raster kept as a panel thumbnail", JSON.stringify(fallback.noMap));
check(fallback.thumbOnly === 1, "no map: thumbnail rendered in the results list", String(fallback.thumbOnly));

const top2 = ordering.order.slice(-2).map((x) => x.split("@")[0]);
check(top2.join(",") === "movecost-origin,movecost-destination", "markers end above a run's rasters and vectors (store-faithful host)", JSON.stringify(ordering.order));
check(ordering.locationGroups === 1, "one locations group survives two runs", `${ordering.locationGroups} created`);
check(ordering.emptyGroups.length === 0, "no empty groups left behind", JSON.stringify(ordering.emptyGroups));
check(noMove.locationGroups === 1, "one locations group on a host that cannot move layers", `${noMove.locationGroups} created over three runs`);
check(new Set(ordering.order.slice(-2).map((x) => x.split("@")[1])).size === 1, "both markers share one locations group after the run");

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll host-layer checks passed.");
process.exit(failures ? 1 : 0);
