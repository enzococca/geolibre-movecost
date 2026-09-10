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
// By default the freshly built repository is served from disk; pass a URL (the
// published one, say) to check the repository users actually install from.
const PUBLISHED = process.argv[2] ?? process.env.MCX_WASM_REPO ?? null;
const PACKAGES = ["codetools", "terra", "sf", "igraph", "ggplot2", "jsonlite", "movecost"];

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
const primary = PUBLISHED ?? `http://127.0.0.1:${server.address().port}`;
log(PUBLISHED ? `installing from ${PUBLISHED}` : `serving build/wasm-repo at ${primary}`);

const webR = new WebR({ interactive: false });
await webR.init();
log("webR up:", (await webR.evalRString("R.version.string")));

log("installing", PACKAGES.join(", "), "— this fetches tens of megabytes");
await webR.installPackages(PACKAGES, { repos: [primary, UPSTREAM], quiet: false });

const versions = await webR.evalRString(`
  paste(vapply(c("movecost", "terra", "sf", "igraph", "ggplot2"),
               function(p) paste0(p, " ", as.character(packageVersion(p))), character(1)),
        collapse = ", ")
`);
log("installed:", versions);

// The engine itself, on the code path the plugin uses in the browser: the
// request and its layers are written into webR's filesystem and mcx_run()
// answers with the JSON the TypeScript side parses.
const engine = await readFile(new URL("../src/engine/movecost-engine.R", import.meta.url), "utf8");
await webR.FS.mkdir("/movecost");
await webR.FS.writeFile("/movecost/engine.R", new TextEncoder().encode(engine));

const check = await webR.evalRString(`
  source("/movecost/engine.R")
  n <- 40
  r <- terra::rast(nrows = n, ncols = n, xmin = 4e5, xmax = 4e5 + n * 50,
                   ymin = 45e5, ymax = 45e5 + n * 50, crs = "EPSG:32633")
  xy <- terra::xyFromCell(r, seq_len(terra::ncell(r)))
  terra::values(r) <- 300 + 400 * exp(-(((xy[, 1] - 4e5) / 2000 - 0.5)^2 +
                                        ((xy[, 2] - 45e5) / 2000 - 0.5)^2) / 0.05)
  terra::writeRaster(r, "/movecost/dtm.tif", overwrite = TRUE)
  pt <- function(x, y, id) sf::st_sf(mcx_id = id,
        geometry = sf::st_sfc(sf::st_point(c(x, y)), crs = 32633))
  sf::st_write(pt(400200, 4500200, "O1"), "/movecost/origin.geojson",
               quiet = TRUE, delete_dsn = TRUE)
  sf::st_write(pt(401800, 4501800, "D1"), "/movecost/destin.geojson",
               quiet = TRUE, delete_dsn = TRUE)

  run <- function(label, req) {
    jsonlite::write_json(req, "/movecost/req.json", auto_unbox = TRUE)
    resp <- jsonlite::fromJSON(mcx_run("/movecost/req.json"), simplifyVector = FALSE)
    if (!isTRUE(resp$ok)) stop(label, ": ", resp$error)
    sprintf("%s ok in %.1fs [%s]", label, resp$elapsedSeconds,
            paste(names(resp$result$vectors), collapse = ","))
  }

  paste(
    run("paths", list(analysis = "paths", dtmPath = "/movecost/dtm.tif",
                      originPath = "/movecost/origin.geojson",
                      destinPath = "/movecost/destin.geojson",
                      params = list(funct = "t", move = 8, time = "h"))),
    run("boundary", list(analysis = "boundary", dtmPath = "/movecost/dtm.tif",
                         originPath = "/movecost/origin.geojson",
                         params = list(funct = "t", move = 8, time = "h",
                                       contValue = 0.5))),
    sep = " | ")
`);
log("engine check:", check);
const reused = await webR.evalRString(
  'if (any(grepl("Reusing", mcx_env$log))) "graph reused on the second run" else "graph rebuilt"',
);
log("surface cache:", reused);

await webR.close();
server.close();
log("done");
