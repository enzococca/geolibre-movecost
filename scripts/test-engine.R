# =============================================================================
# Native smoke test for the movecost engine.
#
#   Rscript scripts/test-engine.R [outdir]
#
# Builds a small synthetic DTM plus a handful of points, runs every analysis the
# plugin exposes, and prints a pass/fail line for each. The same code path runs
# inside webR, so a green run here means the R side of the plugin is sound.
# =============================================================================

suppressPackageStartupMessages({
  library(terra)
  library(sf)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = TRUE)
outdir <- if (length(args)) args[1] else file.path(tempdir(), "mcx-test")
dir.create(outdir, recursive = TRUE, showWarnings = FALSE)

engine <- Sys.getenv("MCX_ENGINE", "src/engine/movecost-engine.R")
if (!file.exists(engine)) stop("Cannot find the engine at ", engine)
source(engine)

cat("Engine loaded. Versions:\n")
print(unlist(mcx_version()))

# --- synthetic terrain -------------------------------------------------------
# A 120 x 120 grid at 50 m resolution in UTM 33N, with two ridges and a valley,
# so slope-dependent cost functions actually have something to bite on.
set.seed(42)
n <- 120
res <- 50
r <- rast(
  nrows = n, ncols = n,
  xmin = 400000, xmax = 400000 + n * res,
  ymin = 4500000, ymax = 4500000 + n * res,
  crs = "EPSG:32633"
)
xy <- xyFromCell(r, seq_len(ncell(r)))
xr <- (xy[, 1] - 400000) / (n * res)
yr <- (xy[, 2] - 4500000) / (n * res)
elev <- 300 +
  400 * exp(-((xr - 0.25)^2 + (yr - 0.30)^2) / 0.02) +
  350 * exp(-((xr - 0.75)^2 + (yr - 0.70)^2) / 0.025) -
  150 * exp(-((xr - 0.5)^2 + (yr - 0.5)^2) / 0.15)
values(r) <- elev
dtm_path <- file.path(outdir, "dtm.tif")
writeRaster(r, dtm_path, overwrite = TRUE)

pt <- function(x, y, id) {
  st_sf(id = id, geometry = st_sfc(st_point(c(x, y)), crs = 32633))
}
origin <- pt(400500, 4500500, "O1")
origins <- rbind(origin, pt(405000, 4500600, "O2"), pt(402500, 4505000, "O3"))
destin <- rbind(pt(405200, 4505200, "D1"), pt(401000, 4505400, "D2"))

write_v <- function(x, name) {
  p <- file.path(outdir, name)
  suppressWarnings(st_write(x, p, driver = "GeoJSON", quiet = TRUE, delete_dsn = TRUE))
  p
}
origin_path <- write_v(origin, "origin.geojson")
origins_path <- write_v(origins, "origins.geojson")
destin_path <- write_v(destin, "destin.geojson")
destin1_path <- write_v(destin[1, ], "destin1.geojson")

# --- cases -------------------------------------------------------------------

cases <- list(
  list(
    label = "paths (Tobler, 16 directions)",
    request = list(
      analysis = "paths", dtmPath = dtm_path,
      originPath = origin_path, destinPath = destin_path,
      params = list(funct = "t", time = "h", move = 16)
    ),
    expect = c("lcps", "isolines")
  ),
  list(
    label = "paths (Pandolf metabolic)",
    request = list(
      analysis = "paths", dtmPath = dtm_path,
      originPath = origin_path, destinPath = destin1_path,
      params = list(funct = "p", move = 8, W = 70, L = 15, N = 1, V = 1.2)
    ),
    expect = c("lcps")
  ),
  list(
    label = "corridor (reach)",
    request = list(
      analysis = "corridor", dtmPath = dtm_path,
      originPath = origin_path, destinPath = destin1_path,
      params = list(funct = "t", move = 8)
    ),
    expect = c("lcpAtoB")
  ),
  list(
    label = "corridor (through, reuses surface)",
    request = list(
      analysis = "corridor", dtmPath = dtm_path,
      originPath = origin_path, destinPath = destin1_path,
      params = list(funct = "t", move = 8, corridorMethod = "through")
    ),
    expect = c("lcpAtoB"),
    reuses_surface = TRUE
  ),
  list(
    label = "network (all pairs)",
    request = list(
      analysis = "network", dtmPath = dtm_path,
      originPath = origins_path,
      params = list(funct = "t", move = 8, netwType = "allpairs")
    ),
    expect = c("network")
  ),
  list(
    label = "allocation",
    request = list(
      analysis = "allocation", dtmPath = dtm_path,
      originPath = origins_path,
      params = list(funct = "t", move = 8)
    ),
    expect = c("boundaries")
  ),
  list(
    label = "boundary (0.5 h and 1 h)",
    request = list(
      analysis = "boundary", dtmPath = dtm_path,
      originPath = origin_path,
      params = list(funct = "t", time = "h", move = 8, contValue = c(0.5, 1))
    ),
    expect = c("boundaries")
  ),
  list(
    label = "rank (3 alternatives)",
    request = list(
      analysis = "rank", dtmPath = dtm_path,
      originPath = origin_path, destinPath = destin1_path,
      params = list(funct = "t", move = 8, lcpN = 3, penalty = 0.01)
    ),
    expect = c("rankedPaths")
  ),
  list(
    label = "terrain factors (movecost 3.1)",
    terrain = TRUE
  ),
  list(
    label = "preview: DTM summary for the map",
    preview = TRUE
  ),
  list(
    label = "grid: browser-fetched Mercator grid to DTM",
    grid = TRUE
  ),
  list(
    label = "error path: paths without destinations",
    request = list(
      analysis = "paths", dtmPath = dtm_path, originPath = origin_path,
      params = list(funct = "t")
    ),
    expect_error = TRUE
  )
)

failures <- 0
for (case in cases) {
  if (isTRUE(case$grid)) {
    # The browser hands over a Float32 grid in Web Mercator; the engine must turn
    # it into a UTM GeoTIFF with a sensible cell size and elevation range.
    gw <- 96; gh <- 80
    xs <- seq(0, 1, length.out = gw); ys <- seq(0, 1, length.out = gh)
    z <- outer(ys, xs, function(y, x) 200 + 900 * exp(-((x - 0.5)^2 + (y - 0.5)^2) / 0.05))
    grid_path <- file.path(outdir, "grid.bin")
    writeBin(as.numeric(t(z)), grid_path, size = 4, endian = "little")
    # Roughly the Vesuvius box, in EPSG:3857 metres.
    req_path <- file.path(outdir, "req-grid.json")
    write_json(list(
      gridPath = grid_path, width = gw, height = gh, crs = "EPSG:3857",
      xmin = 1597000, xmax = 1608000, ymin = 4970000, ymax = 4980000,
      zoom = 11, outPath = file.path(outdir, "grid-dem.tif")
    ), req_path, auto_unbox = TRUE)
    t0 <- Sys.time()
    resp <- fromJSON(mcx_grid_to_dtm(req_path), simplifyVector = FALSE)
    secs <- round(as.numeric(difftime(Sys.time(), t0, units = "secs")), 1)
    ok <- isTRUE(resp$ok) && file.exists(resp$path) &&
      grepl("^EPSG:326", resp$crs) &&
      resp$resolution > 60 && resp$resolution < 120 &&   # ~114 m Mercator * cos(40.8°) ≈ 87 m
      resp$elevation$min > 150 && resp$elevation$max < 1150
    cat(sprintf(
      "[%s] %-38s %ss  %s\n", if (ok) "PASS" else "FAIL", case$label, secs,
      if (isTRUE(resp$ok)) sprintf("%s %dx%d at %.1f m, %.0f-%.0f m", resp$crs, resp$width,
                                   resp$height, resp$resolution, resp$elevation$min, resp$elevation$max)
      else resp$error
    ))
    if (!ok) failures <- failures + 1

    # The same grid under a cell budget must come back coarser, not fail.
    write_json(list(
      gridPath = grid_path, width = gw, height = gh, crs = "EPSG:3857",
      xmin = 1597000, xmax = 1608000, ymin = 4970000, ymax = 4980000,
      zoom = 11, maxCells = 2000, outPath = file.path(outdir, "grid-dem-small.tif")
    ), req_path, auto_unbox = TRUE)
    resp2 <- fromJSON(mcx_grid_to_dtm(req_path), simplifyVector = FALSE)
    ok2 <- isTRUE(resp2$ok) && resp2$width * resp2$height <= 2600 &&
      resp2$resolution > 2 * resp$resolution - 1
    cat(sprintf(
      "[%s] %-38s %s\n", if (ok2) "PASS" else "FAIL", "grid: cell budget aggregates the grid",
      if (isTRUE(resp2$ok)) sprintf("%dx%d at %.1f m", resp2$width, resp2$height, resp2$resolution)
      else resp2$error
    ))
    if (!ok2) failures <- failures + 1
    next
  }

  if (isTRUE(case$terrain)) {
    # movecost 3.1: the terrain-factor raster modulates the surface. Three
    # things must hold: a run with terrain rebuilds the graph instead of
    # reusing the baseline's, its costs differ from the baseline's, and an
    # impassable class (N = "Inf" through the table) forces the path around.
    run_paths <- function(name, extra_req = list(), extra_params = list()) {
      req <- list(analysis = "paths", dtmPath = dtm_path,
                  originPath = origin_path, destinPath = destin1_path,
                  params = c(list(funct = "t", time = "h", move = 8), extra_params))
      req <- c(req, extra_req)
      p <- file.path(outdir, paste0("req-terrain-", name, ".json"))
      write_json(req, p, auto_unbox = TRUE)
      fromJSON(mcx_run(p), simplifyVector = FALSE)
    }

    t0 <- Sys.time()
    base <- run_paths("base")

    # A numeric raster: the factor itself per cell, here 2 everywhere.
    tr_num <- r
    values(tr_num) <- 2
    tr_num_path <- file.path(outdir, "terrain-num.tif")
    writeRaster(tr_num, tr_num_path, overwrite = TRUE)
    num <- run_paths("num", extra_req = list(terrainPath = tr_num_path))

    rebuilt <- !any(grepl("Reusing the cost surface", unlist(num$log)))
    changed <- !identical(base$result$rasters$accumulated$data,
                          num$result$rasters$accumulated$data)
    ok_num <- isTRUE(base$ok) && isTRUE(num$ok) && rebuilt && changed
    secs <- round(as.numeric(difftime(Sys.time(), t0, units = "secs")), 1)
    cat(sprintf("[%s] %-38s %ss  %s\n", if (ok_num) "PASS" else "FAIL",
                "terrain: numeric raster changes the surface", secs,
                if (!isTRUE(num$ok)) num$error
                else paste0(if (rebuilt) "graph rebuilt" else "GRAPH WRONGLY REUSED",
                            ", costs ", if (changed) "changed" else "UNCHANGED")))
    if (!ok_num) failures <- failures + 1

    # A categorical raster: class 2 is a wall across the direct line, made
    # impassable by the table (N = "Inf" — the string, as JSON delivers it);
    # the gap south of y = 4501500 is the only way through.
    wall <- xy[, 1] >= 402000 & xy[, 1] <= 402400 & xy[, 2] >= 4501500
    tr_cat <- r
    values(tr_cat) <- ifelse(wall, 2, 1)
    tr_cat_path <- file.path(outdir, "terrain-cat.tif")
    writeRaster(tr_cat, tr_cat_path, overwrite = TRUE)
    t0 <- Sys.time()
    cat_resp <- run_paths(
      "cat",
      extra_req = list(terrainPath = tr_cat_path),
      extra_params = list(terrainTable = list(
        list(class = 1, N = 1), list(class = 2, N = "Inf")
      ))
    )
    detour <- FALSE
    if (isTRUE(cat_resp$ok) && !is.null(cat_resp$result$vectors$lcps)) {
      lcp_file <- file.path(outdir, "terrain-lcp.geojson")
      writeLines(cat_resp$result$vectors$lcps, lcp_file, useBytes = TRUE)
      lcp <- st_transform(st_read(lcp_file, quiet = TRUE), 32633)
      strip <- st_as_sfc(st_bbox(c(xmin = 402000, xmax = 402400,
                                   ymin = 4500000, ymax = 4506000),
                                 crs = st_crs(32633)))
      crossing <- suppressWarnings(st_crop(lcp, strip))
      # Every crossing of the strip must happen in the gap, below the wall.
      detour <- nrow(crossing) > 0 &&
        as.numeric(st_bbox(crossing)["ymax"]) < 4501500
    }
    secs <- round(as.numeric(difftime(Sys.time(), t0, units = "secs")), 1)
    cat(sprintf("[%s] %-38s %ss  %s\n", if (detour) "PASS" else "FAIL",
                "terrain: Inf class forces the detour", secs,
                if (!isTRUE(cat_resp$ok)) cat_resp$error
                else if (detour) "the path crosses only through the gap"
                else "the path crossed the impassable wall"))
    if (!detour) failures <- failures + 1
    next
  }

  if (isTRUE(case$preview)) {
    req_path <- file.path(outdir, "req-preview.json")
    write_json(list(dtmPath = dtm_path), req_path, auto_unbox = TRUE)
    t0 <- Sys.time()
    resp <- fromJSON(mcx_preview_dtm(req_path), simplifyVector = FALSE)
    secs <- round(as.numeric(difftime(Sys.time(), t0, units = "secs")), 1)
    expected <- resp$raster$width * resp$raster$height * 4
    ok <- isTRUE(resp$ok) &&
      length(jsonlite::base64_dec(resp$raster$data)) == expected &&
      is.finite(resp$elevation$min) && is.finite(resp$elevation$max)
    cat(sprintf(
      "[%s] %-38s %ss  %s\n", if (ok) "PASS" else "FAIL", case$label, secs,
      if (isTRUE(resp$ok)) {
        sprintf("%dx%d at %.1f m, %.0f-%.0f m", resp$width, resp$height,
                resp$resolution, resp$elevation$min, resp$elevation$max)
      } else {
        resp$error
      }
    ))
    if (!ok) failures <- failures + 1
    next
  }

  req_path <- file.path(outdir, paste0("req-", gsub("[^a-z0-9]+", "-", tolower(case$label)), ".json"))
  write_json(case$request, req_path, auto_unbox = TRUE)
  t0 <- Sys.time()
  resp_path <- tryCatch(mcx_run(req_path), error = function(e) {
    cat("  HARD FAIL:", conditionMessage(e), "\n")
    NULL
  })
  secs <- round(as.numeric(difftime(Sys.time(), t0, units = "secs")), 1)
  if (is.null(resp_path)) {
    failures <- failures + 1
    next
  }
  resp <- fromJSON(resp_path, simplifyVector = FALSE)

  if (isTRUE(case$expect_error)) {
    ok <- identical(resp$ok, FALSE)
    cat(sprintf("[%s] %-38s %ss  %s\n", if (ok) "PASS" else "FAIL", case$label, secs,
                if (ok) paste0("error: ", resp$error) else "expected an error"))
    if (!ok) failures <- failures + 1
    next
  }

  if (!isTRUE(resp$ok)) {
    cat(sprintf("[FAIL] %-38s %ss  %s\n", case$label, secs, resp$error))
    failures <- failures + 1
    next
  }

  got <- names(resp$result$vectors)
  missing <- setdiff(case$expect, got)
  rasters <- names(resp$result$rasters)
  ok <- length(missing) == 0
  cat(sprintf(
    "[%s] %-38s %ss  vectors=[%s] rasters=[%s]%s\n",
    if (ok) "PASS" else "FAIL", case$label, secs,
    paste(got, collapse = ","), paste(rasters, collapse = ","),
    if (ok) "" else paste0("  MISSING: ", paste(missing, collapse = ","))
  ))
  if (!ok) failures <- failures + 1

  # movecost 3.0's whole point: a run that changes nothing about the terrain or
  # the cost function must read the graph the previous run built.
  if (isTRUE(case$reuses_surface)) {
    reused <- any(grepl("Reusing the cost surface", unlist(resp$log)))
    cat(sprintf("[%s] %-38s %s\n", if (reused) "PASS" else "FAIL",
                "surface reuse across runs",
                if (reused) "graph reused" else "the graph was rebuilt"))
    if (!reused) failures <- failures + 1
  }

  # Validate the raster payload round-trips as Float32.
  for (rp in resp$result$rasters) {
    raw <- jsonlite::base64_dec(rp$data)
    expected <- rp$width * rp$height * 4
    if (length(raw) != expected) {
      cat("  FAIL raster", rp$name, "byte length", length(raw), "expected", expected, "\n")
      failures <- failures + 1
    }
  }
}

cat("\n", if (failures == 0) "All checks passed." else paste(failures, "check(s) failed."), "\n")
cat("Artefacts in:", outdir, "\n")
quit(status = if (failures == 0) 0 else 1)
