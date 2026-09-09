# =============================================================================
# movecost HTTP backend for the GeoLibre plugin
# -----------------------------------------------------------------------------
# A thin plumber API over the same movecost-engine.R the plugin already uses.
# The plugin POSTs a multipart request (DTM + GeoJSON + parameters) and gets the
# engine's JSON response straight back, so the wire format is identical to the
# one documented in docs/ARCHITECTURE.md.
#
# Start it with:
#
#   Rscript r-backend/start.R              # http://127.0.0.1:8787
#   MOVECOST_PORT=9000 Rscript r-backend/start.R
#
# It listens on the loopback interface only: nothing outside the machine can
# reach it, and no analysis data leaves the machine.
# =============================================================================

# start.R resolves this to an absolute path before plumber parses this file —
# plumber runs an API file with the working directory set to its own folder, so
# a relative path here would break.
engine_path <- Sys.getenv("MOVECOST_ENGINE", "../src/engine/movecost-engine.R")
if (!file.exists(engine_path)) {
  stop("Cannot find the movecost engine at '", engine_path,
       "'. Start the service with: Rscript r-backend/start.R")
}
source(engine_path)

# The plugin runs on a different origin (the GeoLibre app), so the browser sends
# a preflight before every POST. Only loopback origins are worth allowing here.
#* @filter cors
function(req, res) {
  res$setHeader("Access-Control-Allow-Origin", "*")
  res$setHeader("Access-Control-Allow-Headers", "Content-Type")
  res$setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  if (identical(req$REQUEST_METHOD, "OPTIONS")) {
    res$status <- 200
    return(list())
  }
  plumber::forward()
}

#* Liveness and capability probe. The plugin calls this to decide whether a
#* local backend is available before falling back to its in-browser engine.
#* @get /health
#* @serializer unboxedJSON
function() {
  list(
    ok = TRUE,
    service = "movecost-geolibre",
    api = 1,
    versions = mcx_version(),
    analyses = c("paths", "corridor", "network", "allocation", "boundary", "rank")
  )
}

#* Turn a browser-fetched elevation grid into a projected DTM.
#*
#* Multipart: `grid` (raw little-endian Float32, row-major from the top-left),
#* `meta` (JSON: width, height, xmin, ymin, xmax, ymax, crs, zoom), optional
#* `area` (GeoJSON polygon to mask to). Responds like /dem: the GeoTIFF itself,
#* with the summary in the X-Movecost-Summary header.
#*
#* @post /grid
#* @parser multi
#* @parser octet
function(req, res) {
  body <- req$body
  work <- file.path(tempdir(), paste0("mcx-grid-", as.integer(runif(1, 1, 1e9))))
  dir.create(work, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(work, recursive = TRUE, force = TRUE), add = TRUE)

  part <- function(name) {
    value <- body[[name]]
    if (is.null(value)) return(NULL)
    if (is.list(value) && !is.null(value$value)) value$value else value
  }
  text_of <- function(value) if (is.raw(value)) rawToChar(value) else as.character(value)

  grid <- part("grid")
  meta_raw <- part("meta")
  if (is.null(grid) || is.null(meta_raw)) {
    res$status <- 400
    return(list(ok = FALSE, error = "The request needs 'grid' and 'meta' parts."))
  }
  meta <- tryCatch(jsonlite::fromJSON(text_of(meta_raw), simplifyVector = TRUE),
                   error = function(e) NULL)
  if (is.null(meta)) {
    res$status <- 400
    return(list(ok = FALSE, error = "The 'meta' part must be JSON."))
  }

  grid_path <- file.path(work, "grid.bin")
  writeBin(if (is.raw(grid)) grid else as.raw(grid), grid_path)

  area <- part("area")
  area_path <- NULL
  if (!is.null(area) && nzchar(text_of(area))) {
    area_path <- file.path(work, "area.geojson")
    writeLines(text_of(area), area_path, useBytes = TRUE)
  }

  request_path <- file.path(work, "grid-request.json")
  jsonlite::write_json(
    c(as.list(meta), list(gridPath = grid_path, areaPath = area_path,
                          outPath = file.path(work, "dem.tif"))),
    request_path, auto_unbox = TRUE, null = "null"
  )

  summary <- jsonlite::fromJSON(mcx_grid_to_dtm(request_path), simplifyVector = TRUE)
  if (!isTRUE(summary$ok)) {
    res$status <- 422
    res$setHeader("Content-Type", "application/json")
    return(list(ok = FALSE, error = summary$error))
  }
  res$setHeader("X-Movecost-Summary", jsonlite::toJSON(
    summary[setdiff(names(summary), "path")], auto_unbox = TRUE, digits = 6
  ))
  res$setHeader("Access-Control-Expose-Headers", "X-Movecost-Summary")
  res$setHeader("Content-Type", "image/tiff")
  res$body <- readBin(summary$path, "raw", n = file.info(summary$path)$size)
  res
}

#* Summarise a DTM so the plugin can draw it on the map.
#*
#* Expects a multipart body with a single `dtm` GeoTIFF. Responds with the same
#* raster payload shape the analyses use.
#*
#* @post /preview
#* @parser multi
#* @parser octet
#* @serializer json list(auto_unbox = TRUE, null = "null", na = "null", digits = 8)
function(req, res) {
  body <- req$body
  work <- file.path(tempdir(), paste0("mcx-prev-", as.integer(runif(1, 1, 1e9))))
  dir.create(work, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(work, recursive = TRUE, force = TRUE), add = TRUE)

  raw_dtm <- body[["dtm"]]
  if (is.list(raw_dtm) && !is.null(raw_dtm$value)) raw_dtm <- raw_dtm$value
  if (is.null(raw_dtm)) {
    res$status <- 400
    return(list(ok = FALSE, error = "No 'dtm' part in the request."))
  }
  dtm_path <- file.path(work, "dtm.tif")
  writeBin(if (is.raw(raw_dtm)) raw_dtm else as.raw(raw_dtm), dtm_path)

  request_path <- file.path(work, "preview-request.json")
  jsonlite::write_json(list(dtmPath = dtm_path), request_path, auto_unbox = TRUE)

  result <- jsonlite::fromJSON(mcx_preview_dtm(request_path), simplifyVector = FALSE)
  if (!isTRUE(result$ok)) res$status <- 422
  result
}

#* Download a DEM for a drawn area.
#*
#* Expects a multipart body with:
#*   area — GeoJSON text for the polygon (required)
#*   zoom — elevatr zoom level, 1-14 (optional, default 12)
#*
#* Responds with the GeoTIFF itself, so the plugin can hold it exactly like a
#* file the user picked; the summary travels in headers rather than a JSON
#* envelope to avoid base64-inflating the raster.
#*
#* @post /dem
#* @parser multi
#* @parser octet
function(req, res) {
  body <- req$body
  work <- file.path(tempdir(), paste0("mcx-dem-", as.integer(runif(1, 1, 1e9))))
  dir.create(work, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(work, recursive = TRUE, force = TRUE), add = TRUE)

  part <- function(name) {
    value <- body[[name]]
    if (is.null(value)) return(NULL)
    if (is.list(value) && !is.null(value$value)) value$value else value
  }

  area <- part("area")
  if (is.null(area)) {
    res$status <- 400
    return(list(ok = FALSE, error = "No 'area' part in the request."))
  }
  area_text <- if (is.raw(area)) rawToChar(area) else as.character(area)
  area_path <- file.path(work, "area.geojson")
  writeLines(area_text, area_path, useBytes = TRUE)

  zoom_raw <- part("zoom")
  zoom <- suppressWarnings(as.integer(if (is.raw(zoom_raw)) rawToChar(zoom_raw) else zoom_raw))
  if (length(zoom) != 1 || is.na(zoom)) zoom <- 12L

  request_path <- file.path(work, "dem-request.json")
  jsonlite::write_json(
    list(areaPath = area_path, zoom = zoom, outPath = file.path(work, "dem.tif")),
    request_path, auto_unbox = TRUE
  )

  summary <- jsonlite::fromJSON(mcx_fetch_dem(request_path), simplifyVector = TRUE)
  if (!isTRUE(summary$ok)) {
    res$status <- 422
    res$setHeader("Content-Type", "application/json")
    return(list(ok = FALSE, error = summary$error))
  }

  # Everything except the raster itself rides along as a header the browser is
  # allowed to read.
  res$setHeader("X-Movecost-Summary", jsonlite::toJSON(
    summary[setdiff(names(summary), "path")], auto_unbox = TRUE, digits = 6
  ))
  res$setHeader("Access-Control-Expose-Headers", "X-Movecost-Summary")
  res$setHeader("Content-Type", "image/tiff")
  res$body <- readBin(summary$path, "raw", n = file.info(summary$path)$size)
  res
}

#* Run one analysis.
#*
#* Expects a multipart body with:
#*   dtm      — the GeoTIFF (required)
#*   origin   — GeoJSON text (required)
#*   destin   — GeoJSON text (optional)
#*   barrier  — GeoJSON text (optional)
#*   request  — JSON: { "analysis": ..., "params": {...} }
#*
#* @post /run
#* @parser multi
#* @parser octet
#* @serializer json list(auto_unbox = TRUE, null = "null", na = "null", digits = 8)
function(req, res) {
  body <- req$body
  work <- file.path(tempdir(), paste0("mcx-", as.integer(runif(1, 1, 1e9))))
  dir.create(work, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(work, recursive = TRUE, force = TRUE), add = TRUE)

  fail <- function(message) {
    res$status <- 400
    list(ok = FALSE, error = message)
  }

  part <- function(name) {
    value <- body[[name]]
    if (is.null(value)) return(NULL)
    if (is.list(value) && !is.null(value$value)) value$value else value
  }

  # Either a DTM or a study area is required: with no DTM, movecost downloads
  # elevation for the study area itself.
  raw_dtm <- part("dtm")
  dtm_path <- NULL
  if (!is.null(raw_dtm)) {
    dtm_path <- file.path(work, "dtm.tif")
    writeBin(if (is.raw(raw_dtm)) raw_dtm else as.raw(raw_dtm), dtm_path)
  }

  write_text_part <- function(name, filename) {
    value <- part(name)
    if (is.null(value)) return(NULL)
    text <- if (is.raw(value)) rawToChar(value) else as.character(value)
    if (!nzchar(text)) return(NULL)
    path <- file.path(work, filename)
    writeLines(text, path, useBytes = TRUE)
    path
  }

  origin_path <- write_text_part("origin", "origin.geojson")
  if (is.null(origin_path)) return(fail("No 'origin' part in the request."))

  studyplot_path <- write_text_part("studyplot", "studyplot.geojson")

  spec_raw <- part("request")
  spec_text <- if (is.raw(spec_raw)) rawToChar(spec_raw) else as.character(spec_raw)
  spec <- tryCatch(jsonlite::fromJSON(spec_text, simplifyVector = TRUE),
                   error = function(e) NULL)
  if (is.null(spec) || is.null(spec$analysis)) {
    return(fail("The 'request' part must be JSON with an 'analysis' field."))
  }

  if (is.null(dtm_path) && is.null(studyplot_path)) {
    return(fail("The request needs either a 'dtm' or a 'studyplot' part."))
  }

  request <- list(
    analysis = spec$analysis,
    dtmPath = dtm_path,
    studyplotPath = studyplot_path,
    originPath = origin_path,
    destinPath = write_text_part("destin", "destin.geojson"),
    barrierPath = write_text_part("barrier", "barrier.geojson"),
    params = if (is.null(spec$params)) list() else spec$params
  )

  request_path <- file.path(work, "request.json")
  jsonlite::write_json(request, request_path, auto_unbox = TRUE, null = "null")

  response_path <- mcx_run(request_path)
  result <- jsonlite::fromJSON(response_path, simplifyVector = FALSE)
  if (!isTRUE(result$ok)) res$status <- 422
  result
}
