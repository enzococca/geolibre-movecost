#!/usr/bin/env node
// =============================================================================
// Record a short screencast of the plugin at work, for social media.
//
//   node scripts/record-demo.mjs <geolibre-url> <data-base-url> [outdir]
//
// Drives a live GeoLibre build with Playwright while recording the viewport,
// and writes `timeline.json` beside the video: one entry per beat, each with
// the moment it started, the caption to burn in, and the rectangle of the UI
// that matters then, so `scripts/edit-demo.py` can cut, speed up and zoom.
//
// A real screen recording shows no mouse pointer, so a synthetic cursor is
// injected into the page and animated before every click: what the viewer
// sees is the actual application, driven visibly.
// =============================================================================

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const [url, dataBase, outArg] = process.argv.slice(2);
const outdir = resolve(outArg ?? "build/demo");
if (!url || !dataBase) {
  console.error("usage: node scripts/record-demo.mjs <geolibre-url> <data-base-url> [outdir]");
  process.exit(2);
}
mkdirSync(outdir, { recursive: true });

// 1440 x 900 is what the still captures used and what the machine copes with:
// a 1920 x 1080 viewport plus the map, webR and the screencast pushed the
// renderer into a blank page mid-download.
const WIDTH = 1440;
const HEIGHT = 900;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ executablePath: process.env.MCX_CHROMIUM || undefined });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  locale: "en-US",
  recordVideo: { dir: outdir, size: { width: WIDTH, height: HEIGHT } },
});

// The cursor lives in the page, so it is part of the recording.
await context.addInitScript(() => {
  const install = () => {
    if (document.getElementById("__demo_cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #__demo_cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;
        pointer-events:none;transform:translate(-3px,-3px);transition:transform .01s}
      #__demo_ripple{position:fixed;left:0;top:0;width:56px;height:56px;margin:-28px 0 0 -28px;
        border-radius:50%;background:rgba(37,99,235,.35);border:2px solid rgba(37,99,235,.9);
        z-index:2147483646;pointer-events:none;opacity:0;transform:scale(.3)}
      @keyframes __demo_pop{0%{opacity:.9;transform:scale(.25)}70%{opacity:.45}100%{opacity:0;transform:scale(1)}}
      .__demo_pop{animation:__demo_pop .55s ease-out}`;
    document.head.append(style);
    const cursor = document.createElement("div");
    cursor.id = "__demo_cursor";
    cursor.innerHTML =
      `<svg viewBox="0 0 24 24" width="26" height="26">
         <path d="M5 2.5 19.5 12 12.4 13.1 9.6 20z" fill="#111827" stroke="#fff" stroke-width="1.6"
               stroke-linejoin="round"/>
       </svg>`;
    const ripple = document.createElement("div");
    ripple.id = "__demo_ripple";
    document.body.append(ripple, cursor);
    window.__demoCursorAt = (x, y) => { cursor.style.transform = `translate(${x - 3}px,${y - 3}px)`; };
    window.__demoRipple = (x, y) => {
      ripple.style.left = `${x}px`; ripple.style.top = `${y}px`;
      ripple.classList.remove("__demo_pop"); void ripple.offsetWidth; ripple.classList.add("__demo_pop");
    };
    window.__demoCursorAt(window.innerWidth / 2, window.innerHeight / 2);
  };
  // An init script runs before the document exists in some frames, and the
  // host re-renders its shell, so installation is attempted on every entry
  // point and the observer is only attached once there is a node to watch.
  const watch = () => {
    install();
    try {
      if (document.documentElement) {
        new MutationObserver(install).observe(document.documentElement, { childList: true });
      }
    } catch {
      /* an observer is a nicety; the cursor is already installed */
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
  window.addEventListener("load", install);
});

const page = await context.newPage();
page.setDefaultTimeout(120_000);
page.on("pageerror", (e) => log("pageerror:", e.message.slice(0, 160)));
page.on("crash", () => log("PAGE CRASHED"));

// The app blanking out is the failure mode worth catching early: everything
// after it would just time out against an empty document.
const alive = setInterval(async () => {
  try {
    const ok = await page.evaluate(() => document.querySelectorAll("button").length > 5);
    if (!ok) log("WARNING: the page looks empty");
  } catch {
    /* mid-navigation */
  }
}, 15_000);

// --- cursor helpers ----------------------------------------------------------
let cursorX = WIDTH / 2;
let cursorY = HEIGHT / 2;

const glideTo = async (x, y, ms = 420) => {
  const steps = Math.max(8, Math.round(ms / 16));
  const x0 = cursorX;
  const y0 = cursorY;
  for (let i = 1; i <= steps; i += 1) {
    const p = i / steps;
    const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2; // ease in-out
    const cx = x0 + (x - x0) * e;
    const cy = y0 + (y - y0) * e;
    await page.evaluate(([a, b]) => window.__demoCursorAt?.(a, b), [cx, cy]);
    await page.waitForTimeout(16);
  }
  cursorX = x;
  cursorY = y;
};

const clickAt = async (x, y, { hold = 260 } = {}) => {
  await glideTo(x, y);
  await page.evaluate(([a, b]) => window.__demoRipple?.(a, b), [x, y]);
  await page.waitForTimeout(140);
  await page.mouse.click(x, y);
  await page.waitForTimeout(hold);
};

const clickLocator = async (locator, options) => {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  await clickAt(box.x + box.width / 2, box.y + box.height / 2, options);
};

const rectOf = async (selector) => {
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }, selector);
  } catch {
    return null;
  }
};

// --- timeline ----------------------------------------------------------------
const t0 = Date.now();
const timeline = [];
// `cap` is the most screen time this beat may take in the finished video. The
// editor honours it by cutting the segment short rather than speeding it up
// further: past about eight times, a screencast stops being motion and starts
// being a slideshow, so length is bought by cutting, not by acceleration.
const beat = async (caption, { focus = "map", speed = 1, cap = 4 } = {}) => {
  timeline.push({ t: (Date.now() - t0) / 1000, caption, focus, speed, cap });
  log(`beat @${((Date.now() - t0) / 1000).toFixed(1)}s ${focus} ×${speed} — ${caption}`);
};

const menu = async (button, item) => {
  await clickLocator(page.getByRole("button", { name: button }).first());
  await page.waitForTimeout(400);
  await clickLocator(page.getByRole("menuitem", { name: item }).first());
};
const panelButton = (label) =>
  page.locator("button", { hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();

const selectInPicker = async (index, needle) => {
  const ok = await page.evaluate(([i, n]) => {
    const picker = document.querySelectorAll(".mcx-picker")[i];
    const select = picker?.querySelector("select");
    const option = select && [...select.options].find((o) => o.textContent.toLowerCase().includes(n));
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, [index, needle.toLowerCase()]);
  if (!ok) throw new Error(`picker ${index} has no "${needle}"`);
};

// =============================================================================
log("open", url);
// Not `networkidle`: a map streams tiles for as long as it is on screen, so
// the page never goes quiet. Wait for the shell and the canvas instead.
await page.goto(url, { waitUntil: "commit", timeout: 120_000 });
await page.waitForSelector(".maplibregl-canvas", { timeout: 300_000 });
await page.getByRole("button", { name: /^Plugins$/ }).first().waitFor({ timeout: 240_000 });
await page.waitForTimeout(5000);
log("loaded");

// 1 — activate the plugin
await beat("Least-cost path analysis inside GeoLibre", { focus: "full", speed: 1, cap: 4 });
await menu(/^Plugins$/, /movecost — least-cost analysis/);
await page.waitForTimeout(1600);
await beat("The movecost R package, as a GeoLibre plugin", { focus: "full", speed: 1, cap: 3.5 });
await menu(/^movecost$/, /Open the movecost panel/);
await page.waitForTimeout(2200);
await beat("No R installed: R itself runs in the page (WebAssembly)", { focus: "panel", speed: 1, cap: 3 });
await page.waitForTimeout(2600);

// 2 — the data
await beat("Sites and study area — loaded, drawn or clicked on the map", { focus: "full", speed: 6, cap: 4 });
const loadVector = async (file) => {
  await menu(/^Add Data$/, /^Vector Layer$/);
  await page.waitForTimeout(900);
  const input = page.locator("input[type='url']").first();
  await clickLocator(input, { hold: 120 });
  await input.fill(`${dataBase}/${file}`);
  await page.waitForTimeout(250);
  await clickLocator(page.locator("button", { hasText: /^Load$/ }).first(), { hold: 120 });
  await page.waitForTimeout(4200);
  log("loaded", file);
};
await loadVector("pompeii-origin.geojson");
await loadVector("destinations.geojson");
await loadVector("vesuvius-study-area.geojson");
const closePanel = page.getByRole("button", { name: /^Close panel$/ }).first();
if (await closePanel.count()) await clickLocator(closePanel, { hold: 200 });
await page.waitForTimeout(2500);

// 3 — terrain
await beat("Pompeii, Herculaneum and Oplontis around Vesuvius", { focus: "map", speed: 1, cap: 4 });
await page.waitForTimeout(2200);
const areaSelect = page.locator(".mcx-section select").filter({ hasText: /polygon layer/i }).first();
await clickLocator(areaSelect.first(), { hold: 200 }).catch(() => {});
await page.evaluate(() => {
  for (const select of document.querySelectorAll("select")) {
    const option = [...select.options].find((o) => /vesuvius/i.test(o.textContent));
    if (option) { select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); return; }
  }
});
await page.waitForTimeout(1400);

// A coarser DEM for the demo: fewer cells is lighter on the browser, and at
// this scale the paths are the same story.
await page.evaluate(() => {
  for (const select of document.querySelectorAll(".mcx-section select")) {
    const option = [...select.options].find((o) => /^11 —/.test(o.textContent.trim()));
    if (option) { select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); return; }
  }
});
await page.waitForTimeout(1200);
await beat("The DEM is sized before it is fetched, to fit in memory", { focus: "panel", speed: 1, cap: 2.6 });
await page.waitForTimeout(2800);
await beat("Elevation downloaded tile by tile, projected to UTM", { focus: "full", speed: 8, cap: 3 });
await clickLocator(panelButton("Download DEM"));
await page.waitForFunction(() => /Hide terrain/.test(document.body.innerText), null, { timeout: 300_000 });
await page.waitForTimeout(3000);
await beat("Projected to UTM and drawn straight onto the map", { focus: "map", speed: 1, cap: 2.6 });
await page.waitForTimeout(2600);

// 4 — locations
await beat("Origin and destinations: from a layer, or clicked", { focus: "full", speed: 1, cap: 4 });
await selectInPicker(0, "pompeii");
await page.waitForTimeout(1500);
await selectInPicker(1, "destinations");
await page.waitForTimeout(2600);

// 5 — run
await beat("Tobler's hiking function — 26 cost functions available", { focus: "panel", speed: 1, cap: 2.6 });
await page.waitForTimeout(2000);
await beat("movecost runs in the browser: no server, no install", { focus: "full", speed: 8, cap: 4 });
await clickLocator(panelButton("Run analysis"));
await page.waitForFunction(
  () => /Remove these result layers|Least-cost paths — [\d.]+ s in/.test(document.body.innerText),
  null,
  { timeout: 600_000 },
);
await page.waitForTimeout(3500);

// 6 — results
await beat("Cost surface, isolines and the least-cost paths", { focus: "map", speed: 1, cap: 4 });
await page.waitForTimeout(3800);
await beat("Every result is a native GeoLibre layer, grouped per run", { focus: "layers", speed: 1, cap: 3.5 });
await page.waitForTimeout(3600);
await beat("Desktop, and on the iPad too", { focus: "map", speed: 1, cap: 2.6 });
await page.waitForTimeout(2600);

timeline.push({ t: (Date.now() - t0) / 1000, caption: "__end__", focus: "map", speed: 1 });

// Rectangles of the three regions the editor can zoom into.
const rects = {
  full: { x: 0, y: 0, w: WIDTH, h: HEIGHT },
  panel: (await rectOf("aside:has(.mcx-panel), .mcx-panel")) ?? { x: 1420, y: 60, w: 500, h: 1000 },
  layers: (await rectOf("[class*='layers'], aside")) ?? { x: 0, y: 60, w: 520, h: 1000 },
  map: (await rectOf(".maplibregl-canvas")) ?? { x: 520, y: 60, w: 900, h: 1000 },
};

clearInterval(alive);
await page.close();
await context.close();
await browser.close();

const video = readdirSync(outdir).filter((f) => f.endsWith(".webm")).sort().pop();
if (video) renameSync(join(outdir, video), join(outdir, "raw.webm"));
writeFileSync(join(outdir, "timeline.json"), JSON.stringify({ width: WIDTH, height: HEIGHT, rects, timeline }, null, 2));
log("done →", join(outdir, "raw.webm"));
