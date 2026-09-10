#!/usr/bin/env node
// =============================================================================
// Two analyses in a real GeoLibre build, counting what they leave behind.
//
//   node scripts/check-layer-churn.mjs <geolibre-url> <data-base-url>
//
// Raising the markers above a run's rasters used to start a new
// "movecost · locations" group every time and, because each re-registration
// makes the host rebuild its style, knock out the drawing plugin's own sources
// — after which MapLibre logs "There is no tile manager with ID 'gm_temporary'"
// once a frame. Both are counted here: groups from the Layers panel, the
// MapLibre error from the console.
// =============================================================================

import { chromium } from "playwright";

const [url, dataBase] = process.argv.slice(2);
if (!url || !dataBase) {
  console.error("usage: node scripts/check-layer-churn.mjs <geolibre-url> <data-base-url>");
  process.exit(2);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(120_000);

let tileManagerErrors = 0;
let geomanWarnings = 0;
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("tile manager with ID")) tileManagerErrors += 1;
  if (t.includes("_gm:helper") || t.includes("MapEvents: handler not found")) geomanWarnings += 1;
});
page.on("pageerror", (e) => log("pageerror:", e.message.slice(0, 160)));

const menu = async (button, item) => {
  await page.getByRole("button", { name: button }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("menuitem", { name: item }).first().click();
};
const pluginButton = (label) =>
  page.locator("button", { hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
const countGroups = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("*")].filter(
      (n) => n.children.length === 0 && n.textContent?.trim() === "movecost · locations",
    ).length,
  );

log("open", url);
await page.goto(url, { waitUntil: "commit" });
await page.waitForSelector(".maplibregl-canvas");
await page.waitForTimeout(4000);

await menu(/^Plugins$/, /movecost — least-cost analysis/);
await page.waitForTimeout(2000);
await menu(/^movecost$/, /Open the movecost panel/);
await page.waitForTimeout(2500);

const loadVector = async (file) => {
  await menu(/^Add Data$/, /^Vector Layer$/);
  await page.waitForTimeout(1500);
  await page.locator("input[type='url']").first().fill(`${dataBase}/${file}`);
  await page.locator("button", { hasText: /^Load$/ }).first().click();
  await page.waitForTimeout(5000);
};
await loadVector("pompeii-origin.geojson");
await loadVector("destinations.geojson");
await loadVector("vesuvius-study-area.geojson");
const close = page.getByRole("button", { name: /^Close panel$/ }).first();
if (await close.count()) await close.click();
await page.waitForTimeout(3000);

await page.evaluate(() => {
  for (const s of document.querySelectorAll("select")) {
    const o = [...s.options].find((x) => /vesuvius/i.test(x.textContent));
    if (o) { s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return; }
  }
  throw new Error("no select offers the study-area layer");
});
await page.waitForTimeout(1200);
await pluginButton("Download DEM").click();
await page.waitForFunction(() => /Hide terrain/.test(document.body.innerText), null, { timeout: 900_000 });
await page.waitForTimeout(4000);
log("DEM ready; groups so far:", await countGroups());

const pick = async (index, needle) => {
  const ok = await page.evaluate(([i, n]) => {
    const sel = document.querySelectorAll(".mcx-picker")[i]?.querySelector("select");
    const o = sel && [...sel.options].find((x) => x.textContent.toLowerCase().includes(n));
    if (!o) return false;
    sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); return true;
  }, [index, needle]);
  if (!ok) throw new Error(`picker ${index} offers no "${needle}"`);
};
await pick(0, "pompeii");
await page.waitForTimeout(1500);
await pick(1, "destinations");
await page.waitForTimeout(2000);
log("points placed; groups:", await countGroups(), "| gm_temporary:", tileManagerErrors);

for (const run of [1, 2]) {
  const before = tileManagerErrors;
  await pluginButton("Run analysis").click();
  await page.waitForFunction(
    (n) => (document.body.innerText.match(/Remove these result layers/g) ?? []).length >= 1 &&
           document.body.innerText.includes(`#${n}`),
    run, { timeout: 1_800_000 },
  ).catch(() => {});
  await page.waitForTimeout(8000);
  log(`run ${run}: groups=${await countGroups()} gm_temporary=+${tileManagerErrors - before} (total ${tileManagerErrors})`);
}

log("RESULT groups:", await countGroups(), "| gm_temporary errors:", tileManagerErrors,
    "| geoman warnings:", geomanWarnings);
await browser.close();
