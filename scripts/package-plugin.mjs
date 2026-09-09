#!/usr/bin/env node
/**
 * Zips the built plugin the way GeoLibre's installer expects: `plugin.json` at
 * the archive root, with `dist/index.js` and `dist/style.css` beside it.
 *
 *   npm run package        ->  build/movecost-<version>.zip
 *
 * Uses the system `zip` when available and falls back to a minimal stored-entry
 * writer, so the script works on a machine without zip installed.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateRaw, crc32 } from "node:zlib";

const execFileAsync = promisify(execFile);
const deflateAsync = promisify(deflateRaw);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, "build", "staging");
const outDir = join(root, "build");

async function main() {
  const manifestPath = join(root, "geolibre-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  // The host ignores unknown manifest keys, but an older build need not, and a
  // rejected install says nothing about which key caused it. So the packaged
  // manifest carries only the documented fields; catalogue metadata such as
  // author, homepage and minGeoLibreVersion belongs in the registry entry
  // (plugin-registry-entry.json), not here.
  const ALLOWED = new Set([
    "id", "name", "version", "entry", "style", "description", "engines",
  ]);
  const unexpected = Object.keys(manifest).filter((key) => !ALLOWED.has(key));
  if (unexpected.length) {
    throw new Error(
      `geolibre-plugin/plugin.json has non-manifest keys: ${unexpected.join(", ")}. ` +
        `Move them to plugin-registry-entry.json.`,
    );
  }

  for (const required of ["dist/index.js", "dist/style.css"]) {
    if (!existsSync(join(root, required))) {
      throw new Error(`Missing ${required}. Run "npm run build" first.`);
    }
  }

  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const versionTs = readFileSync(join(root, "src/version.ts"), "utf8");
  const exported = /PLUGIN_VERSION = "([^"]+)"/.exec(versionTs)?.[1];
  if (exported !== manifest.version) {
    throw new Error(
      `Version mismatch: src/version.ts exports ${exported}, plugin.json says ${manifest.version}. ` +
        `The host rejects a bundle whose exported version does not match its manifest.`,
    );
  }
  if (manifest.version !== pkg.version) {
    throw new Error(
      `Version mismatch: plugin.json says ${manifest.version}, package.json says ${pkg.version}. ` +
        `The host rejects a bundle whose exported version does not match its manifest.`,
    );
  }

  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, "dist"), { recursive: true });
  await writeFile(join(staging, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  await cp(join(root, "dist", "index.js"), join(staging, "dist", "index.js"));
  await cp(join(root, "dist", "style.css"), join(staging, "dist", "style.css"));

  const zipPath = join(outDir, `${manifest.id}-${manifest.version}.zip`);
  await rm(zipPath, { force: true });

  try {
    // -D omits directory entries and -X drops platform extra fields: the
    // archive then carries nothing but the three files the host asks for,
    // which is the safest thing to hand to an unfamiliar unzip implementation
    // (the mobile build's, for one).
    await execFileAsync("zip", ["-r", "-q", "-D", "-X", zipPath, "plugin.json", "dist"], {
      cwd: staging,
    });
  } catch {
    await writeStoredZip(zipPath, [
      ["plugin.json", await readFile(join(staging, "plugin.json"))],
      ["dist/index.js", await readFile(join(staging, "dist", "index.js"))],
      ["dist/style.css", await readFile(join(staging, "dist", "style.css"))],
    ]);
  }

  console.log(`Packaged ${zipPath}`);
}

/** Minimal ZIP writer (deflate entries, no directory entries). */
async function writeStoredZip(zipPath, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = await deflateAsync(data);
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(sum, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  await new Promise((resolveWrite, rejectWrite) => {
    const stream = createWriteStream(zipPath);
    stream.on("error", rejectWrite);
    stream.on("finish", resolveWrite);
    stream.end(Buffer.concat([...chunks, centralBuf, end]));
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
