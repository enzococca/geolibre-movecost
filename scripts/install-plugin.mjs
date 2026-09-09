#!/usr/bin/env node
/**
 * Copies the built plugin into a GeoLibre Desktop installation as an unpacked
 * plugin directory, which the app can load from Settings without going through
 * the registry.
 *
 *   npm run install:geolibre
 *   GEOLIBRE_PLUGIN_DIR=/path/to/plugins npm run install:geolibre
 *
 * Prints the destination so it can be pasted into GeoLibre's
 * "Install from directory" dialog on hosts that ask for the path explicitly.
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Tauri app-data roots GeoLibre Desktop is known to use, per platform. */
function candidateRoots() {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return [join(home, "Library", "Application Support")];
    case "win32":
      return [process.env.APPDATA ?? join(home, "AppData", "Roaming")];
    default:
      return [
        process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
        join(home, ".config"),
      ];
  }
}

/** GeoLibre's bundle identifier is not fixed across builds, so match loosely. */
async function findPluginDir() {
  if (process.env.GEOLIBRE_PLUGIN_DIR) return process.env.GEOLIBRE_PLUGIN_DIR;

  for (const base of candidateRoots()) {
    if (!existsSync(base)) continue;
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/geolibre/i.test(entry.name)) continue;
      return join(base, entry.name, "plugins");
    }
  }
  return null;
}

async function main() {
  for (const required of ["dist/index.js", "dist/style.css"]) {
    if (!existsSync(join(root, required))) {
      throw new Error(`Missing ${required}. Run "npm run build" first.`);
    }
  }

  const manifest = JSON.parse(await readFile(join(root, "geolibre-plugin", "plugin.json"), "utf8"));
  const pluginsDir = await findPluginDir();

  if (!pluginsDir) {
    console.error(
      "Could not find a GeoLibre Desktop data directory.\n" +
        "Set GEOLIBRE_PLUGIN_DIR to the app's plugins folder and run this again,\n" +
        "or install build/*.zip from GeoLibre's Manage Plugins dialog.",
    );
    process.exit(1);
  }

  const target = join(pluginsDir, manifest.id);
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, "dist"), { recursive: true });
  await writeFile(join(target, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  await cp(join(root, "dist", "index.js"), join(target, "dist", "index.js"));
  await cp(join(root, "dist", "style.css"), join(target, "dist", "style.css"));

  console.log(`Installed ${manifest.id} ${manifest.version} into:\n  ${target}`);
  console.log("Restart GeoLibre Desktop, then enable it in Manage Plugins.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
