#!/usr/bin/env node
// =============================================================================
// Install the plugin's R stack inside webR under Node and run the engine on a
// small synthetic DTM.
//
//   node scripts/test-wasm-install.mjs
//
// This is the check that the WebAssembly side actually works: the browser is a
// slow place to discover that a package will not load. build/wasm-repo is
// served over HTTP (webR installs by URL, never from disk) and consulted before
// repo.r-wasm.org, exactly as the plugin does at runtime.
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WebR } from "webr";

const REPO_DIR = new URL("../build/wasm-repo/", import.meta.url).pathname;
const UPSTREAM = "https://repo.r-wasm.org";
const PACKAGES = ["terra", "sf", "igraph", "ggplot2", "jsonlite", "movecost"];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const types = { ".gz": "application/gzip", ".tgz": "application/gzip", ".rds": "application/octet-stream" };
const server = createServer(async (req, res) => {
  try {
    const path = join(REPO_DIR, normalize(decodeURIComponent(req.url.split("?")[0])));
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const local = `http://127.0.0.1:${server.address().port}`;
log("serving build/wasm-repo at", local);

const webR = new WebR({ interactive: false });
await webR.init();
log("webR up:", (await webR.evalRString("R.version.string")));

log("installing", PACKAGES.join(", "), "— this fetches tens of megabytes");
await webR.installPackages(PACKAGES, { repos: [local, UPSTREAM], quiet: false });

const versions = await webR.evalRString(`
  paste(vapply(c("movecost", "terra", "sf", "igraph", "ggplot2"),
               function(p) paste0(p, " ", as.character(packageVersion(p))), character(1)),
        collapse = ", ")
`);
log("installed:", versions);

const check = await webR.evalRString(`
  suppressPackageStartupMessages(library(movecost))
  n <- 40
  r <- terra::rast(nrows = n, ncols = n, xmin = 4e5, xmax = 4e5 + n * 50,
                   ymin = 45e5, ymax = 45e5 + n * 50, crs = "EPSG:32633")
  xy <- terra::xyFromCell(r, seq_len(terra::ncell(r)))
  terra::values(r) <- 300 + 0.05 * (xy[, 1] - 4e5) + 0.03 * (xy[, 2] - 45e5)
  pt <- function(x, y) sf::st_sf(id = 1, geometry = sf::st_sfc(sf::st_point(c(x, y)), crs = 32633))
  s <- mc_surface(r, funct = "t", move = 8)
  p <- mc_paths(s, origin = pt(400200, 4500200), destin = pt(401800, 4501800))
  sprintf("surface %s, path cost %.3f h over %.0f m",
          class(s)[1], as.numeric(p$paths$cost[1]), as.numeric(p$paths$length[1]))
`);
log("engine check:", check);

await webR.close();
server.close();
log("done");
