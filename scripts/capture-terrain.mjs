// Capture the 0.3.0 / movecost 3.1.1 novelties against the LOCAL R service:
// clean backend badge, a baseline run, the terrain-factor raster + class table,
// the rerun whose path detours around the Inf class, and the engine log.
//
//   node capture-terrain.mjs <geolibre-url> <data-base-url> <terrain-tif> [outdir] [class-table]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const [url, dataBase, terrainTif, outArg, tableArg] = process.argv.slice(2);
const outdir = resolve(outArg ?? "build/terrain-shots");
const classTable = tableArg ?? "1=1, 2=Inf";
mkdirSync(outdir, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  locale: "en-US",
});
const page = await context.newPage();
page.setDefaultTimeout(120_000);
page.on("pageerror", (e) => log("pageerror:", e.message.slice(0, 160)));

const shot = async (name, options = {}) => {
  await page.screenshot({ path: `${outdir}/${name}.png`, ...options });
  log("shot", name);
};
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
const waitRunFinished = async () => {
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Run analysis/.test(x.textContent));
    return b && !b.disabled;
  }, null, { timeout: 600_000 });
  await page.waitForTimeout(3500);
};

log("open", url);
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".maplibregl-canvas");
await page.waitForTimeout(4000);

// Activate (Plugins → Installed) and open the panel.
await page.getByRole("button", { name: /^Plugins$/ }).first().click();
await page.waitForTimeout(500);
await page.getByText(/^Installed$/).first().click();
await page.waitForTimeout(500);
await page.getByText(/movecost — least-cost analysis/).first().click();
await page.waitForTimeout(2000);
await menu(/^movecost$/, /Open the movecost panel/);
await page.waitForTimeout(2500);
// The local R service must have answered the probe.
await page.waitForFunction(() => /Local R service/.test(document.body.innerText), null, { timeout: 60_000 });
await shot("10-backend-local", { clip: await panelBox() });

// Walkthrough layers.
const loadVector = async (file) => {
  await menu(/^Add data$/i, /^Vector Layer$/i);
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
const closePanel = page.getByRole("button", { name: /^Close panel$/ }).first();
if (await closePanel.count()) await closePanel.click();
await page.waitForTimeout(1500);

// Study area → DEM.
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
await pluginButton("Download DEM").click();
await page.waitForFunction(() => /Hide terrain/.test(document.body.innerText), null, { timeout: 900_000 });
await page.waitForTimeout(4000);

// Points, baseline run.
await selectLayer(0, "pompeii");
await page.waitForTimeout(1500);
await selectLayer(1, "destinations");
await page.waitForTimeout(2000);
await pluginButton("Run analysis").click();
log("baseline run on the local R service…");
await waitRunFinished();
await shot("11-run-local-baseline");

// movecost 3.1: terrain-factor raster + class table.
await page.locator('input.mcx-file[type="file"]').first().setInputFiles(terrainTif);
await page.waitForTimeout(1500);
const table = page.getByPlaceholder("e.g. 1=1, 2=0.8, 3=Inf").first();
await table.fill(classTable);
await table.press("Tab");
await page.waitForTimeout(800);
// Bring the terrain block into view for its close-up.
await page.getByText(/Terrain factors \(optional, GeoTIFF\)/).first().scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await shot("12-terrain-inputs", { clip: await panelBox() });

await pluginButton("Run analysis").click();
log("terrain run — the Inf class must force the detour…");
await waitRunFinished();
await shot("13-terrain-detour");

// The engine log names the terrain raster and movecost's own messages.
const logSummary = page.getByText(/Engine log/).first();
await logSummary.scrollIntoViewIfNeeded();
await logSummary.click();
await page.waitForTimeout(800);
await shot("14-engine-log", { clip: await panelBox() });

await browser.close();
log("done");
