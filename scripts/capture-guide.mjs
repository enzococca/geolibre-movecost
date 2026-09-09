#!/usr/bin/env node
// =============================================================================
// Capture the user-guide screenshots from a live GeoLibre web build.
//
//   node scripts/capture-guide.mjs <geolibre-url> <data-base-url> [outdir]
//
// Drives GeoLibre with Playwright: activates movecost, loads the walkthrough
// layers (docs/guide/data — Pompeii as origin, Herculaneum and Villa Poppaea
// as destinations, a study area over Vesuvius) from `data-base-url`, downloads
// the DEM for the current view, picks the points from those layers, runs a
// least-cost path analysis in webR and screenshots every stage into `outdir`
// (default docs/images). Slow — the first webR run downloads ~65 MB of R —
// so every step is logged.
// =============================================================================

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const [url, dataBase, outArg] = process.argv.slice(2);
const outdir = resolve(outArg ?? "docs/images");
if (!url || !dataBase) {
  console.error("usage: node scripts/capture-guide.mjs <geolibre-url> <data-base-url> [outdir]");
  process.exit(2);
}
mkdirSync(outdir, { recursive: true });

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

const browser = await chromium.launch({ executablePath: process.env.MCX_CHROMIUM || undefined });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  locale: "en-US",
});
const page = await context.newPage();
page.setDefaultTimeout(120_000);
page.on("pageerror", (e) => log("pageerror:", e.message.slice(0, 200)));

const shot = async (name, options = {}) => {
  await page.screenshot({ path: `${outdir}/${name}.png`, ...options });
  log("shot", name);
};
// The plugin's own mount container: the host's panel body, header excluded.
const panelBox = async () => {
  const intro = page.locator(".mcx-section--intro").first();
  const box = await intro.evaluate((n) => {
    const r = n.parentElement.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  return box.width > 0 ? box : undefined;
};
const menu = async (button, item) => {
  await page.getByRole("button", { name: button }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("menuitem", { name: item }).first().click();
};
const pluginButton = (label) =>
  page.locator("button", { hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();

// Picks `optionText` in the <select> of the n-th point picker (origin = 0,
// destinations = 1). The pickers offer every point layer the host lists.
const selectLayer = async (pickerIndex, optionText) => {
  const ok = await page.evaluate(([index, needle]) => {
    const picker = document.querySelectorAll(".mcx-picker")[index];
    const select = picker?.querySelector("select");
    const option = select && [...select.options].find((o) => o.textContent.toLowerCase().includes(needle));
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, [pickerIndex, optionText.toLowerCase()]);
  if (!ok) throw new Error(`picker ${pickerIndex} offers no "${optionText}" layer`);
};

log("open", url);
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".maplibregl-canvas");
await page.waitForTimeout(4000);

// --- 1. Activate the plugin and open the panel ------------------------------
await menu(/^Plugins$/, /movecost — least-cost analysis/);
await page.waitForTimeout(2000);
await shot("01-plugin-activated");
await menu(/^movecost$/, /Open the movecost panel/);
await page.waitForTimeout(2500);
await shot("02-panel-open");

// --- 2. Load the walkthrough layers -----------------------------------------
const loadVector = async (file) => {
  await menu(/^Add Data$/, /^Vector Layer$/);
  await page.waitForTimeout(1500);
  const input = page.locator("input[type='url']").first();
  await input.fill(`${dataBase}/${file}`);
  await page.locator("button", { hasText: /^Load$/ }).first().click();
  await page.waitForTimeout(5000);
  log("loaded", file);
};
await loadVector("pompeii-origin.geojson");
await loadVector("destinations.geojson");
await loadVector("vesuvius-study-area.geojson");
// Close the Add Vector Layer panel if it is still open.
const closePanel = page.getByRole("button", { name: /^Close panel$/ }).first();
if (await closePanel.count()) await closePanel.click();
await page.waitForTimeout(1500);
await shot("03-study-area");

// --- 3. Terrain: current view, DEM download ---------------------------------
// The study area from its layer (the terrain section's own layer select).
// The panel re-renders its layer lists a moment after layers change.
await page.waitForTimeout(3000);
await page.evaluate(() => {
  for (const select of document.querySelectorAll("select")) {
    const option = [...select.options].find((o) => /vesuvius/i.test(o.textContent));
    if (option) {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
  }
  throw new Error("no select offers the study-area layer");
});
await page.waitForTimeout(1200);
await shot("04-terrain-estimate", { clip: await panelBox() });
await pluginButton("Download DEM").click();
await page.waitForFunction(() => /Hide terrain/.test(document.body.innerText), null, {
  timeout: 900_000,
});
await page.waitForTimeout(4000);
await shot("05-dem-downloaded");

// --- 4. Origin and destinations from the layers -----------------------------
await selectLayer(0, "pompeii");
await page.waitForTimeout(1500);
await selectLayer(1, "destinations");
await page.waitForTimeout(2000);
await shot("06-points-from-layers");

// --- 5. Run ------------------------------------------------------------------
await pluginButton("Run analysis").click();
log("running — the first run fetches webR and the R packages");
await page.waitForFunction(
  () => /Remove these result layers|Least-cost paths — [\d.]+ s in/.test(document.body.innerText),
  null,
  { timeout: 1_800_000 },
);
await page.waitForTimeout(5000);
await shot("07-results");
await shot("08-results-panel", { clip: await panelBox() });

await browser.close();
log("done");
