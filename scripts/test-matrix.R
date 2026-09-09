# =============================================================================
# Full matrix check for the movecost engine.
#
#   Rscript scripts/test-matrix.R [outdir]
#
# Every analysis the plugin exposes, run twice — without a barrier and with one
# — plus every one of the 26 cost functions, the movement neighbourhoods, both
# time units, the cognitive-slope and topographic-distance options, and the
# surface cache. Each run is checked for the layers it should produce, that the
# GeoJSON actually carries features, and that the raster payloads are the byte
# length their dimensions imply.
#
# The barrier runs assert more than "no error": a wall between origin and
# destination has to make the crossing dearer, or the barrier is decorative.
# =============================================================================

suppressPackageStartupMessages({
  library(terra); library(sf); library(jsonlite)
})

args <- commandArgs(trailingOnly = TRUE)
outdir <- if (length(args)) args[1] else file.path(tempdir(), "mcx-matrix")
dir.create(outdir, recursive = TRUE, showWarnings = FALSE)
source(Sys.getenv("MCX_ENGINE", "src/engine/movecost-engine.R"))

cat("movecost", as.character(packageVersion("movecost")),
    "| R", paste0(R.version$major, ".", R.version$minor), "\n\n")

# --- fixture -----------------------------------------------------------------
# 80 x 80 at 50 m: a ridge between the origin and the destinations, so slope is
# not incidental to the result, and small enough for 26 runs in a row.
n <- 80; res <- 50
x0 <- 400000; y0 <- 4500000
r <- rast(nrows = n, ncols = n, xmin = x0, xmax = x0 + n * res,
          ymin = y0, ymax = y0 + n * res, crs = "EPSG:32633")
xy <- xyFromCell(r, seq_len(ncell(r)))
xr <- (xy[, 1] - x0) / (n * res); yr <- (xy[, 2] - y0) / (n * res)
values(r) <- 300 + 500 * exp(-((xr + yr - 1)^2) / 0.01) - 100 * exp(-((xr - 0.5)^2) / 0.3)
dtm_path <- file.path(outdir, "dtm.tif")
writeRaster(r, dtm_path, overwrite = TRUE)

pt <- function(x, y, id) st_sf(mcx_id = id, geometry = st_sfc(st_point(c(x, y)), crs = 32633))
write_v <- function(x, name) {
  p <- file.path(outdir, name)
  suppressWarnings(st_write(x, p, driver = "GeoJSON", quiet = TRUE, delete_dsn = TRUE))
  p
}

origin  <- pt(x0 + 500,  y0 + 500,  "O1")
origins <- rbind(origin, pt(x0 + 3500, y0 + 600, "O2"), pt(x0 + 900, y0 + 3400, "O3"))
destin  <- rbind(pt(x0 + 3600, y0 + 3600, "D1"), pt(x0 + 1200, y0 + 3500, "D2"))

# A wall straight across the grid between the origin and the destinations, with
# a gap at the right-hand edge so the destinations stay reachable: an
# impassable ring would only prove that an unreachable destination errors.
# Everything has to funnel through that gap, which is what makes the cost
# comparison below meaningful.
#
# The +25 m matters: cells are 50 m, so a line laid exactly on y0 + 2000 runs
# along cell boundaries and touches almost none of them — it removes 16 edges
# instead of 950 and blocks nothing. Barriers are rasterised by which cells
# they fall in, so the line is put through the middle of a row.
wall <- st_sf(
  id = 1,
  geometry = st_sfc(st_linestring(rbind(
    c(x0 - 100, y0 + 2025), c(x0 + 3400, y0 + 2025)
  )), crs = 32633)
)
wall84 <- st_transform(wall, 4326)

paths <- list(
  dtm = dtm_path,
  origin = write_v(origin, "origin.geojson"),
  origins = write_v(origins, "origins.geojson"),
  destin = write_v(destin, "destin.geojson"),
  destin1 = write_v(destin[1, ], "destin1.geojson"),
  barrier = write_v(wall, "barrier.geojson")
)

# --- harness -----------------------------------------------------------------
failures <- 0
pass <- function(ok, label, detail = "") {
  cat(sprintf("[%s] %-52s %s\n", if (ok) "PASS" else "FAIL", label, detail))
  if (!ok) failures <<- failures + 1
  invisible(ok)
}

run <- function(analysis, params, origin_path, destin_path = NULL, barrier_path = NULL) {
  req <- list(analysis = analysis, dtmPath = paths$dtm, originPath = origin_path,
              params = params)
  if (!is.null(destin_path)) req$destinPath <- destin_path
  if (!is.null(barrier_path)) req$barrierPath <- barrier_path
  f <- file.path(outdir, "req.json")
  write_json(req, f, auto_unbox = TRUE)
  t0 <- Sys.time()
  out <- fromJSON(mcx_run(f), simplifyVector = FALSE)
  out$secs <- as.numeric(difftime(Sys.time(), t0, units = "secs"))
  out
}

#' Every layer present, non-empty, and every raster the size it claims.
check_result <- function(resp, label, vectors, rasters = character(0)) {
  if (!isTRUE(resp$ok)) {
    return(pass(FALSE, label, resp$error))
  }
  got <- names(resp$result$vectors)
  missing <- setdiff(vectors, got)
  empty <- character(0)
  for (k in intersect(vectors, got)) {
    fc <- tryCatch(fromJSON(resp$result$vectors[[k]], simplifyVector = FALSE), error = function(e) NULL)
    if (is.null(fc) || !length(fc$features)) empty <- c(empty, k)
  }
  bad_raster <- character(0)
  for (k in rasters) {
    rp <- resp$result$rasters[[k]]
    if (is.null(rp)) {
      bad_raster <- c(bad_raster, paste0(k, ":missing"))
    } else if (length(jsonlite::base64_dec(rp$data)) != rp$width * rp$height * 4) {
      bad_raster <- c(bad_raster, paste0(k, ":bytes"))
    }
  }
  ok <- !length(missing) && !length(empty) && !length(bad_raster)
  pass(ok, label, sprintf(
    "%.1fs %s%s", resp$secs, paste(got, collapse = ","),
    if (ok) "" else paste0("  MISSING:", paste(c(missing, empty, bad_raster), collapse = ","))
  ))
}

base <- function(...) modifyList(list(funct = "t", move = 8, time = "h"), list(...))

# --- 1. every analysis, without and with a barrier ---------------------------
cat("== analyses, no barrier\n")
check_result(run("paths", base(), paths$origin, paths$destin),
             "paths", c("lcps", "isolines", "destinations"), c("accumulated", "costSurface"))
check_result(run("corridor", base(), paths$origin, paths$destin1),
             "corridor (reach)", c("lcpAtoB", "lcpBtoA"), "corridor")
check_result(run("corridor", base(corridorMethod = "through"), paths$origin, paths$destin1),
             "corridor (through)", c("lcpAtoB", "lcpBtoA"), "corridor")
check_result(run("network", base(netwType = "allpairs", lcpDensity = TRUE), paths$origins),
             "network (all pairs, density)", c("network", "nodes"), "density")
check_result(run("network", base(netwType = "neigh"), paths$origins),
             "network (neighbours)", c("network", "nodes"))
check_result(run("allocation", base(isolines = TRUE), paths$origins),
             "allocation", c("boundaries", "isolines"), "allocation")
check_result(run("boundary", base(contValue = c(0.4, 0.8)), paths$origins),
             "boundary (two limits, three origins)", "boundaries", "accumulated")
check_result(run("rank", base(lcpN = 3, penalty = 0.01), paths$origin, paths$destin1),
             "rank", "rankedPaths", "corridor")

cat("\n== analyses, with a barrier\n")
check_result(run("paths", base(), paths$origin, paths$destin, paths$barrier),
             "paths + barrier", c("lcps", "isolines", "destinations"), c("accumulated", "costSurface"))
check_result(run("corridor", base(), paths$origin, paths$destin1, paths$barrier),
             "corridor + barrier", c("lcpAtoB", "lcpBtoA"), "corridor")
check_result(run("network", base(), paths$origins, NULL, paths$barrier),
             "network + barrier", c("network", "nodes"))
check_result(run("allocation", base(), paths$origins, NULL, paths$barrier),
             "allocation + barrier", "boundaries", "allocation")
check_result(run("boundary", base(contValue = 0.6), paths$origin, NULL, paths$barrier),
             "boundary + barrier", "boundaries", "accumulated")
check_result(run("rank", base(lcpN = 3), paths$origin, paths$destin1, paths$barrier),
             "rank + barrier", "rankedPaths", "corridor")

# --- 2. the barrier has to bite ----------------------------------------------
cat("\n== the barrier changes the answer\n")
cost_of <- function(resp) {
  d <- resp$result$tables$destinations
  if (is.null(d)) return(NA_real_)
  as.numeric(d[[1]]$cost %||% d$cost[[1]])
}
`%||%` <- function(a, b) if (is.null(a)) b else a

#' Does the least-cost path a run produced cross the wall?
crosses_wall <- function(resp, key = "lcps") {
  gj <- resp$result$vectors[[key]]
  if (is.null(gj)) return(NA)
  line <- st_read(gj, quiet = TRUE)
  any(lengths(st_crosses(line, wall84)) > 0)
}

free <- run("paths", base(), paths$origin, paths$destin1)
walled <- run("paths", base(), paths$origin, paths$destin1, paths$barrier)
c_free <- cost_of(free); c_wall <- cost_of(walled)
pass(isTRUE(crosses_wall(free)), "without the barrier the path crosses that line")
pass(isFALSE(crosses_wall(walled)), "with the barrier the path does not cross it")
# The detour has to cost something. How much depends on the terrain — here the
# ridge dominates and the gap is cheap to reach — so the check that the barrier
# bites is the crossing test above, and this one only pins the direction.
pass(is.finite(c_free) && is.finite(c_wall) && c_wall > c_free * 1.001,
     "a wall makes the crossing dearer",
     sprintf("%.3f h -> %.3f h (+%.0f%%)", c_free, c_wall, 100 * (c_wall / c_free - 1)))

# A permeable barrier (field 0.2) penalises the crossing without forbidding it,
# so it must land between the two — and may legitimately still cross.
leaky <- run("paths", base(field = 0.2), paths$origin, paths$destin1, paths$barrier)
c_leaky <- cost_of(leaky)
pass(is.finite(c_leaky) && c_leaky >= c_free * 0.999 && c_leaky <= c_wall * 1.001,
     "a permeable barrier sits between free and walled",
     sprintf("%.3f h", c_leaky))

# The barrier belongs to the surface now, so analyses that movecost 2.x could
# not give one to must honour it as well.
net <- run("network", base(), paths$origins, NULL, paths$barrier)
pass(isFALSE(crosses_wall(net, "network")), "network paths respect the barrier")
rnk <- run("rank", base(lcpN = 3), paths$origin, paths$destin1, paths$barrier)
pass(isFALSE(crosses_wall(rnk, "rankedPaths")), "ranked paths respect the barrier")

# --- 2b. barriers as a host actually hands them over --------------------------
cat("\n== awkward barrier layers\n")
# A host's "sketches" layer holds every drawing: the rectangle that defined the
# study area next to the line meant as a wall, with list-valued properties.
# terra cannot make one SpatVector out of mixed geometry types, so this used to
# fail with "[as,sf] coercion failed".
sketches <- st_sf(
  gm_shape = c("rectangle", "line"),
  gm_centre = I(list(c(1, 2), c(3, 4))),
  geometry = st_sfc(
    st_polygon(list(rbind(c(x0 + 3000, y0 + 3000), c(x0 + 3900, y0 + 3000),
                          c(x0 + 3900, y0 + 3900), c(x0 + 3000, y0 + 3900),
                          c(x0 + 3000, y0 + 3000)))),
    st_linestring(rbind(c(x0 - 100, y0 + 2025), c(x0 + 3400, y0 + 2025))),
    crs = 32633
  )
)
mixed <- write_v(sketches, "sketches.geojson")
check_result(run("paths", base(), paths$origin, paths$destin, mixed),
             "mixed line + polygon barrier", c("lcps", "isolines"))
# Z coordinates and empty geometries are the other two things a drawing layer
# arrives with.
zm <- st_sf(id = 1:2, geometry = st_sfc(
  st_linestring(cbind(c(x0 - 100, x0 + 3400), c(y0 + 2025, y0 + 2025), c(10, 20))),
  st_linestring(cbind(c(x0 + 100, x0 + 200), c(y0 + 2025, y0 + 2025), c(10, 20))),
  crs = 32633))
check_result(run("paths", base(), paths$origin, paths$destin, write_v(zm, "zm.geojson")),
             "barrier with Z coordinates", "lcps")

# --- 3. every cost function ---------------------------------------------------
cat("\n== all 26 cost functions (paths)\n")
functs <- movecost::mc_cost_functions()
bad <- character(0)
for (i in seq_len(nrow(functs))) {
  code <- functs$code[i]
  resp <- run("paths", base(funct = code, W = 70, L = 10, N = 1, V = 1.2, slCrit = 10),
              paths$origin, paths$destin1)
  if (!isTRUE(resp$ok) || is.null(resp$result$vectors$lcps)) {
    bad <- c(bad, paste0(code, ": ", if (isTRUE(resp$ok)) "no path" else resp$error))
  }
}
pass(!length(bad), sprintf("%d cost functions produce a path", nrow(functs)),
     if (length(bad)) paste(bad, collapse = " | ") else paste(functs$code, collapse = " "))

# --- 4. options ---------------------------------------------------------------
cat("\n== options\n")
for (mv in c(4, 8, 16)) {
  resp <- run("paths", base(move = mv), paths$origin, paths$destin1)
  check_result(resp, sprintf("move = %d", mv), "lcps", "accumulated")
}
h <- run("paths", base(time = "h"), paths$origin, paths$destin1)
m <- run("paths", base(time = "m"), paths$origin, paths$destin1)
pass(abs(cost_of(m) / cost_of(h) - 60) < 0.5, "minutes are sixty times hours",
     sprintf("%.3f h = %.1f m", cost_of(h), cost_of(m)))
check_result(run("paths", base(cognSlope = TRUE), paths$origin, paths$destin1),
             "cognitive slope", "lcps")
check_result(run("paths", base(topoDist = TRUE), paths$origin, paths$destin1),
             "topographic distance", "lcps")
check_result(run("paths", base(returnBase = TRUE), paths$origin, paths$destin1),
             "return paths", c("lcps", "lcpsBack"))
check_result(run("paths", base(breaks = 0.1), paths$origin, paths$destin1),
             "explicit isoline interval", c("lcps", "isolines"))

# --- 5. the cache -------------------------------------------------------------
cat("\n== the surface cache\n")
first <- run("paths", base(funct = "hrz"), paths$origin, paths$destin1)
again <- run("rank", base(funct = "hrz", lcpN = 2), paths$origin, paths$destin1)
pass(any(grepl("Reusing", unlist(again$log))), "same settings reuse the graph",
     sprintf("%.1fs then %.1fs", first$secs, again$secs))
changed <- run("paths", base(funct = "hrz", move = 16), paths$origin, paths$destin1)
pass(!any(grepl("Reusing", unlist(changed$log))), "changed settings rebuild the graph")
walled_again <- run("paths", base(funct = "hrz", move = 16), paths$origin, paths$destin1, paths$barrier)
pass(!any(grepl("Reusing", unlist(walled_again$log))), "adding a barrier rebuilds the graph")

# --- 6. the log is always a list ---------------------------------------------
one_line <- run("paths", base(), paths$origin, paths$destin1)
pass(is.list(one_line$log), "log stays a list even with one line",
     paste(length(one_line$log), "line(s)"))

cat("\n", if (failures == 0) "All matrix checks passed." else paste(failures, "check(s) failed."), "\n")
cat("Artefacts in:", outdir, "\n")
quit(status = if (failures == 0) 0 else 1)
