# =============================================================================
# movecost engine for the GeoLibre plugin
# -----------------------------------------------------------------------------
# Runs entirely inside webR (R compiled to WebAssembly) but is deliberately
# plain R so that it can also be executed by a native Rscript for testing:
#
#   Rscript -e 'source("src/engine/movecost-engine.R"); mcx_run("request.json")'
#
# Contract
# --------
#   input : a JSON request file describing the analysis (see docs/ARCHITECTURE.md)
#   output: a JSON response file; vectors are inlined as GeoJSON strings, rasters
#           are inlined as base64 Float32 arrays plus their WGS84 extent so that
#           the JavaScript side can colourise them on a canvas without needing a
#           GeoTIFF reader.
#
# No plotting ever happens here: movecost draws to the active graphics device as
# a side effect, so every call is wrapped in a null device.
# =============================================================================

mcx_env <- new.env(parent = emptyenv())
mcx_env$log <- character(0)
mcx_env$target_crs <- NULL
# DTMs kept in this R session rather than on disk, by handle. Needed under webR,
# where terra::writeRaster() never returns for rasters above a couple of
# thousand cells; the analyses and the preview accept a handle in place of a
# path, so a downloaded DTM never has to become a file there.
mcx_env$dtms <- list()

mcx_log <- function(...) {
  msg <- paste0(...)
  mcx_env$log <- c(mcx_env$log, msg)
  invisible(msg)
}

mcx_stop <- function(...) stop(paste0(...), call. = FALSE)

# --- environment -------------------------------------------------------------

mcx_version <- function() {
  list(
    r = paste0(R.version$major, ".", R.version$minor),
    movecost = as.character(utils::packageVersion("movecost")),
    terra = as.character(utils::packageVersion("terra")),
    sf = as.character(utils::packageVersion("sf")),
    raster = as.character(utils::packageVersion("raster"))
  )
}

mcx_require <- function() {
  needed <- c("movecost", "raster", "sp", "sf", "terra", "jsonlite")
  missing <- needed[!vapply(needed, requireNamespace, logical(1), quietly = TRUE)]
  if (length(missing)) {
    mcx_stop("Missing R packages: ", paste(missing, collapse = ", "))
  }
  invisible(TRUE)
}

# movecost renders a plot on every call. Inside webR that would try to paint on
# the canvas device and slow everything down, so we swallow it.
mcx_quietly <- function(expr) {
  grDevices::pdf(NULL)
  on.exit(
    {
      try(grDevices::dev.off(), silent = TRUE)
    },
    add = TRUE
  )
  suppressWarnings(suppressMessages(force(expr)))
}

# --- CRS helpers -------------------------------------------------------------

# movecost derives slope from the DTM, which only makes sense on a projected
# grid whose units are metres. A geographic DTM is reprojected to the UTM zone
# of its own centroid unless the caller asked otherwise.
mcx_is_geographic <- function(r) {
  isTRUE(terra::is.lonlat(r, warn = FALSE))
}

mcx_utm_epsg <- function(lon, lat) {
  zone <- floor((lon + 180) / 6) + 1
  if (lat >= 0) 32600 + zone else 32700 + zone
}

mcx_prepare_dtm <- function(path, reproject = TRUE) {
  if (!file.exists(path)) mcx_stop("DTM file not found: ", path)
  r <- terra::rast(path)
  if (terra::nlyr(r) > 1) r <- r[[1]]
  crs_wkt <- terra::crs(r)
  if (is.na(crs_wkt) || !nzchar(crs_wkt)) {
    mcx_stop("The DTM has no CRS. Assign one before running the analysis.")
  }
  if (mcx_is_geographic(r)) {
    if (!reproject) {
      mcx_stop(
        "The DTM is in geographic coordinates (degrees). movecost needs a ",
        "projected DTM in metres. Enable auto-reprojection or supply a ",
        "projected DTM."
      )
    }
    e <- terra::ext(r)
    epsg <- mcx_utm_epsg((e$xmin + e$xmax) / 2, (e$ymin + e$ymax) / 2)
    mcx_log("Reprojecting DTM from geographic CRS to EPSG:", epsg)
    r <- terra::project(r, paste0("EPSG:", epsg), method = "bilinear")
  }
  names(r) <- "dtm"
  r
}

#' The DTM a request refers to: a kept in-memory raster by handle, or a file.
mcx_resolve_dtm <- function(req, reproject = TRUE) {
  handle <- req$dtmHandle
  if (!is.null(handle) && nzchar(handle)) {
    r <- mcx_env$dtms[[handle]]
    if (is.null(r)) {
      mcx_stop("The DTM '", handle, "' is no longer in this R session. Download it again.")
    }
    return(r)
  }
  if (is.null(req$dtmPath) || !nzchar(req$dtmPath) || !file.exists(req$dtmPath)) {
    return(NULL)
  }
  mcx_prepare_dtm(req$dtmPath, reproject = reproject)
}

# --- vector helpers ----------------------------------------------------------

mcx_read_vector <- function(path, target_crs, what = "layer") {
  if (is.null(path) || is.na(path) || !nzchar(path)) {
    return(NULL)
  }
  if (!file.exists(path)) mcx_stop(what, " file not found: ", path)
  v <- sf::st_read(path, quiet = TRUE)
  if (nrow(v) == 0) mcx_stop(what, " contains no features.")
  if (is.na(sf::st_crs(v))) sf::st_crs(v) <- 4326
  v <- sf::st_transform(v, target_crs)
  v
}

# movecost 2.x expects sp classes; keep at least one attribute column so the
# coercion produces a SpatialPointsDataFrame rather than a bare SpatialPoints.
mcx_as_spatial <- function(v) {
  if (is.null(v)) {
    return(NULL)
  }
  keep <- setdiff(names(v), attr(v, "sf_column"))
  if (!length(keep)) v$mcx_id <- seq_len(nrow(v))
  methods::as(v, "Spatial")
}

mcx_sf_to_geojson <- function(x, fallback_crs = mcx_env$target_crs) {
  if (is.null(x)) {
    return(NULL)
  }
  v <- if (inherits(x, "sf")) x else sf::st_as_sf(x)
  if (is.null(v) || nrow(v) == 0) {
    return(NULL)
  }
  # movecost hands back sp objects built on raster/sp; round-tripping them
  # through sf sometimes drops the CRS, so restore the one the analysis ran in.
  if (is.na(sf::st_crs(v)) && !is.null(fallback_crs)) {
    sf::st_crs(v) <- fallback_crs
  }
  if (is.na(sf::st_crs(v))) {
    mcx_stop("A result layer came back without a CRS and none could be inferred.")
  }
  v <- sf::st_transform(v, 4326)
  # Drop columns sf cannot serialise (lists, matrices) before writing.
  drop <- vapply(sf::st_drop_geometry(v), function(col) !is.atomic(col), logical(1))
  if (any(drop)) v <- v[, !c(drop, FALSE), drop = FALSE]
  tmp <- tempfile(fileext = ".geojson")
  on.exit(unlink(tmp), add = TRUE)
  suppressWarnings(sf::st_write(
    v, tmp,
    driver = "GeoJSON", quiet = TRUE, delete_dsn = TRUE,
    layer_options = c("RFC7946=YES", "WRITE_BBOX=YES")
  ))
  paste(readLines(tmp, warn = FALSE), collapse = "")
}

# --- raster helpers ----------------------------------------------------------

# Rasters travel as a base64 Float32Array plus a WGS84 extent. That keeps the
# payload self-describing and lets the plugin paint it on a canvas overlay
# without pulling a GeoTIFF decoder into the bundle.
mcx_raster_payload <- function(x, name, max_cells = 1.2e6,
                               fallback_crs = mcx_env$target_crs) {
  if (is.null(x)) {
    return(NULL)
  }
  r <- if (inherits(x, "SpatRaster")) x else terra::rast(x)
  if (terra::nlyr(r) > 1) r <- r[[1]]
  crs_now <- terra::crs(r)
  if ((is.na(crs_now) || !nzchar(crs_now)) && !is.null(fallback_crs)) {
    terra::crs(r) <- sf::st_crs(fallback_crs)$wkt
  }
  if (is.na(terra::crs(r)) || !nzchar(terra::crs(r))) {
    mcx_log("Raster '", name, "' has no CRS; skipping it.")
    return(NULL)
  }

  ncell <- terra::ncell(r)
  if (ncell > max_cells) {
    fact <- ceiling(sqrt(ncell / max_cells))
    mcx_log("Downsampling raster '", name, "' by a factor of ", fact, " for transport")
    r <- terra::aggregate(r, fact = fact, fun = "mean", na.rm = TRUE)
  }

  r84 <- if (mcx_is_geographic(r)) r else terra::project(r, "EPSG:4326", method = "bilinear")

  vals <- terra::values(r84, mat = FALSE)
  vals[is.nan(vals) | is.infinite(vals)] <- NA_real_
  finite <- vals[!is.na(vals)]

  e <- terra::ext(r84)
  list(
    name = name,
    width = terra::ncol(r84),
    height = terra::nrow(r84),
    bounds = list(
      west = e$xmin, south = e$ymin, east = e$xmax, north = e$ymax
    ),
    min = if (length(finite)) min(finite) else NA_real_,
    max = if (length(finite)) max(finite) else NA_real_,
    # NA is encoded as NaN, which survives the Float32 round-trip and is easy
    # to test for on the JavaScript side.
    data = jsonlite::base64_enc(
      writeBin(as.numeric(ifelse(is.na(vals), NaN, vals)), raw(), size = 4, endian = "little")
    )
  )
}

# --- parameter plumbing ------------------------------------------------------

mcx_pick <- function(params, name, default) {
  v <- params[[name]]
  if (is.null(v) || (length(v) == 1 && is.na(v))) default else v
}

# Cost-function parameters shared by every movecost entry point.
mcx_common_args <- function(params) {
  list(
    funct     = mcx_pick(params, "funct", "t"),
    move      = as.integer(mcx_pick(params, "move", 16)),
    cogn.slp  = isTRUE(mcx_pick(params, "cognSlope", FALSE)),
    topo.dist = isTRUE(mcx_pick(params, "topoDist", FALSE)),
    sl.crit   = as.numeric(mcx_pick(params, "slCrit", 10)),
    W         = as.numeric(mcx_pick(params, "W", 70)),
    L         = as.numeric(mcx_pick(params, "L", 0)),
    N         = as.numeric(mcx_pick(params, "N", 1)),
    V         = as.numeric(mcx_pick(params, "V", 1.2))
  )
  # `z` is deliberately absent: it is elevatr's zoom level, meaningful only when
  # movecost downloads the terrain itself, and it is supplied by the terrain
  # list in that case. Setting it here as well makes movecost reject the call
  # with "formal argument z matched by multiple actual arguments".
}

# Cost functions whose output is a duration; only these accept `time`.
MCX_TIME_FUNCTIONS <- c(
  "t", "tofp", "mp", "icmonp", "icmoffp", "icfonp", "icfoffp",
  "ug", "ma", "alb", "gkrs", "r", "ks", "trp"
)

mcx_is_time_function <- function(funct) funct %in% MCX_TIME_FUNCTIONS

mcx_call <- function(fun, args) {
  mcx_quietly(do.call(fun, args))
}

# --- analyses ----------------------------------------------------------------

mcx_analysis_paths <- function(terrain, origin, destin, barrier, params) {
  args <- c(
    terrain,
    list(
      origin = origin, destin = destin, barrier = barrier,
      field = as.numeric(mcx_pick(params, "field", 0)),
      irregular.dtm = isTRUE(mcx_pick(params, "irregularDtm", FALSE)),
      return.base = isTRUE(mcx_pick(params, "returnBase", FALSE)),
      graph.out = FALSE, export = FALSE
    ),
    mcx_common_args(params)
  )
  if (mcx_is_time_function(args$funct)) args$time <- mcx_pick(params, "time", "h")
  breaks <- mcx_pick(params, "breaks", NULL)
  if (!is.null(breaks) && length(breaks)) args$breaks <- as.numeric(breaks)

  res <- mcx_call(movecost::movecost, args)

  list(
    vectors = list(
      lcps      = mcx_sf_to_geojson(res$LCPs),
      lcpsBack  = mcx_sf_to_geojson(res$LCPs.back),
      isolines  = mcx_sf_to_geojson(res$isolines),
      destinations = mcx_sf_to_geojson(res$dest.loc.w.cost)
    ),
    rasters = list(
      accumulated = mcx_raster_payload(res$accumulated.cost.raster, "accumulated_cost"),
      costSurface = mcx_raster_payload(res$cost.surface, "cost_surface")
    ),
    tables = list(
      destinations = if (!is.null(res$dest.loc.w.cost)) {
        as.data.frame(res$dest.loc.w.cost)
      } else {
        NULL
      }
    )
  )
}

mcx_analysis_corridor <- function(terrain, a, b, barrier, params) {
  args <- c(
    terrain,
    list(
      a = a, b = b, barrier = barrier,
      field = as.numeric(mcx_pick(params, "field", 0)),
      irregular.dtm = isTRUE(mcx_pick(params, "irregularDtm", FALSE)),
      rescale = isTRUE(mcx_pick(params, "rescale", FALSE)),
      graph.out = FALSE, export = FALSE
    ),
    mcx_common_args(params)
  )
  if (mcx_is_time_function(args$funct)) args$time <- mcx_pick(params, "time", "h")

  res <- mcx_call(movecost::movecorr, args)

  list(
    vectors = list(
      lcpAtoB = mcx_sf_to_geojson(res$lcp_a_to_b),
      lcpBtoA = mcx_sf_to_geojson(res$lcp_b_to_a)
    ),
    rasters = list(
      corridor = mcx_raster_payload(res$lc.corridor, "least_cost_corridor")
    )
  )
}

mcx_analysis_network <- function(terrain, origin, barrier, params) {
  args <- c(
    terrain,
    list(
      origin = origin, barrier = barrier,
      netw.type = mcx_pick(params, "netwType", "allpairs"),
      field = as.numeric(mcx_pick(params, "field", 0)),
      irregular.dtm = isTRUE(mcx_pick(params, "irregularDtm", FALSE)),
      lcp.dens = isTRUE(mcx_pick(params, "lcpDensity", FALSE)),
      export = FALSE
    ),
    mcx_common_args(params)
  )

  res <- mcx_call(movecost::movenetw, args)

  merged <- res$LCPs.netw.merged
  if (is.null(merged)) merged <- res$LCPs.netw.neigh.merged

  list(
    vectors = list(
      network = mcx_sf_to_geojson(merged)
    ),
    rasters = list(
      density = mcx_raster_payload(res$LCPs.density.perc, "lcp_density_percent")
    ),
    tables = list(
      costMatrixHours   = if (!is.null(res$cost.matrix.hr)) as.data.frame(res$cost.matrix.hr) else NULL,
      costMatrixMinutes = if (!is.null(res$cost.matrix.min)) as.data.frame(res$cost.matrix.min) else NULL,
      costMatrix        = if (!is.null(res$cost.matrix)) as.data.frame(res$cost.matrix) else NULL
    )
  )
}

mcx_analysis_allocation <- function(terrain, origin, params) {
  args <- c(
    terrain,
    list(
      origin = origin,
      isolines = isTRUE(mcx_pick(params, "isolines", FALSE)),
      export = FALSE
    ),
    mcx_common_args(params)
  )
  args$field <- NULL # movealloc has no `field` argument
  if (mcx_is_time_function(args$funct)) args$time <- mcx_pick(params, "time", "h")
  breaks <- mcx_pick(params, "breaks", NULL)
  if (!is.null(breaks) && length(breaks)) args$breaks <- as.numeric(breaks)

  res <- mcx_call(movecost::movealloc, args)

  list(
    vectors = list(
      boundaries = mcx_sf_to_geojson(res$alloc.boundaries),
      isolines   = mcx_sf_to_geojson(res$isolines)
    ),
    rasters = list(
      allocation = mcx_raster_payload(res$cost.allocation.raster, "cost_allocation")
    )
  )
}

mcx_analysis_boundary <- function(terrain, origin, barrier, params) {
  cont <- mcx_pick(params, "contValue", NULL)
  if (is.null(cont) || !length(cont)) {
    mcx_stop("The boundary analysis needs at least one cost limit (cont.value).")
  }
  args <- c(
    terrain,
    list(
      origin = origin, barrier = barrier,
      cont.value = as.numeric(cont),
      field = as.numeric(mcx_pick(params, "field", 0)),
      add.geom = TRUE,
      export = FALSE
    ),
    mcx_common_args(params)
  )
  if (mcx_is_time_function(args$funct)) args$time <- mcx_pick(params, "time", "h")

  res <- mcx_call(movecost::movebound, args)

  list(
    vectors = list(
      isolines = mcx_sf_to_geojson(res$isolines),
      origins  = mcx_sf_to_geojson(res$origin_w_isolines_geom)
    ),
    rasters = list()
  )
}

mcx_analysis_rank <- function(terrain, origin, destin, barrier, params) {
  args <- c(
    terrain,
    list(
      origin = origin, destin = destin, barrier = barrier,
      lcp.n = as.integer(mcx_pick(params, "lcpN", 3)),
      irregular.dtm = isTRUE(mcx_pick(params, "irregularDtm", FALSE)),
      use.corr = isTRUE(mcx_pick(params, "useCorridor", FALSE)),
      export = FALSE
    ),
    mcx_common_args(params)
  )
  args$field <- NULL # moverank has no `field` argument
  if (mcx_is_time_function(args$funct)) args$time <- mcx_pick(params, "time", "h")

  res <- mcx_call(movecost::moverank, args)

  list(
    vectors = list(
      rankedPaths = mcx_sf_to_geojson(res$LCPs)
    ),
    rasters = list(
      corridor = mcx_raster_payload(res$lc.corr, "least_cost_corridor")
    )
  )
}

# --- online elevation --------------------------------------------------------

# Approximate ground resolution of an AWS terrain tile at the equator, per zoom
# level. Used only to describe the download before and after it happens.
mcx_zoom_resolution <- function(z) 156543.03392 / (2^z)

#' Download a DEM for a drawn area.
#'
#' Wraps elevatr's AWS terrain tiles. The area arrives as a WGS84 GeoJSON
#' polygon; the DEM comes back projected to the UTM zone of its centroid, which
#' is what the cost functions need, and clipped to the polygon.
#'
#' @param request_path JSON with `areaPath`, `zoom`, and an optional `outPath`
#' @param response_path where to write the JSON response
mcx_fetch_dem <- function(request_path, response_path = NULL) {
  mcx_env$log <- character(0)
  started <- Sys.time()
  if (is.null(response_path)) {
    response_path <- paste0(tools::file_path_sans_ext(request_path), ".response.json")
  }

  out <- tryCatch(
    {
      if (!requireNamespace("elevatr", quietly = TRUE)) {
        mcx_stop("The R package 'elevatr' is not installed. install.packages(\"elevatr\")")
      }
      req <- jsonlite::fromJSON(request_path, simplifyVector = TRUE)
      if (is.null(req$areaPath) || !file.exists(req$areaPath)) {
        mcx_stop("No area polygon was supplied.")
      }
      zoom <- as.integer(mcx_pick(req, "zoom", 12))
      if (is.na(zoom) || zoom < 1 || zoom > 14) {
        mcx_stop("Zoom level must be between 1 and 14.")
      }

      area <- sf::st_read(req$areaPath, quiet = TRUE)
      if (nrow(area) == 0) mcx_stop("The area layer has no features.")
      if (is.na(sf::st_crs(area))) sf::st_crs(area) <- 4326
      area <- sf::st_transform(area, 4326)
      area <- sf::st_make_valid(sf::st_union(area))
      geom_type <- as.character(sf::st_geometry_type(area, by_geometry = FALSE))
      if (!grepl("POLYGON", geom_type)) {
        mcx_stop("The area must be a polygon, not a ", tolower(geom_type), ".")
      }

      centroid <- sf::st_coordinates(sf::st_centroid(area))
      epsg <- mcx_utm_epsg(centroid[1, 1], centroid[1, 2])
      mcx_log("Downloading elevation at zoom ", zoom, "; projecting to EPSG:", epsg)

      area_sf <- sf::st_sf(geometry = sf::st_sfc(area, crs = 4326))
      dem <- suppressWarnings(suppressMessages(
        elevatr::get_elev_raster(
          locations = area_sf, z = zoom, src = "aws",
          clip = "locations", verbose = FALSE, override_size_check = TRUE
        )
      ))

      r <- terra::rast(dem)
      r <- terra::project(r, paste0("EPSG:", epsg), method = "bilinear")
      names(r) <- "dtm"

      out_path <- mcx_pick(req, "outPath", NULL)
      if (is.null(out_path)) {
        out_path <- file.path(dirname(request_path), "dem.tif")
      }
      terra::writeRaster(r, out_path, overwrite = TRUE, gdal = c("COMPRESS=DEFLATE"))

      e <- terra::ext(r)
      e84 <- terra::ext(terra::project(r, "EPSG:4326"))
      values <- terra::values(r, mat = FALSE)
      finite <- values[!is.na(values)]

      list(
        ok = TRUE,
        path = out_path,
        bytes = file.info(out_path)$size,
        crs = paste0("EPSG:", epsg),
        zoom = zoom,
        width = terra::ncol(r),
        height = terra::nrow(r),
        resolution = as.numeric(terra::res(r))[1],
        elevation = list(
          min = if (length(finite)) min(finite) else NA_real_,
          max = if (length(finite)) max(finite) else NA_real_
        ),
        bounds = list(west = e84$xmin, south = e84$ymin, east = e84$xmax, north = e84$ymax),
        extentProjected = list(xmin = e$xmin, ymin = e$ymin, xmax = e$xmax, ymax = e$ymax),
        elapsedSeconds = as.numeric(difftime(Sys.time(), started, units = "secs")),
        log = mcx_env$log
      )
    },
    error = function(e) {
      list(ok = FALSE, error = conditionMessage(e), log = mcx_env$log)
    }
  )

  jsonlite::write_json(out, response_path, auto_unbox = TRUE, null = "null",
                       na = "null", digits = 8)
  invisible(response_path)
}

#' Turn an elevation grid fetched in the browser into a projected DTM.
#'
#' The JavaScript side downloads AWS Terrarium tiles and decodes them into a
#' Float32 grid in Web Mercator (EPSG:3857). Slope on a Mercator grid would be
#' wrong by 1/cos(latitude), so the grid is reprojected to the UTM zone of its
#' centroid here, optionally masked to the drawn area, and written as a GeoTIFF
#' — after which it is indistinguishable from an uploaded or elevatr-fetched DTM.
#'
#' @param request_path JSON with `gridPath` (raw little-endian Float32, row-major
#'   from the top-left), `width`, `height`, `xmin`/`ymin`/`xmax`/`ymax` in the
#'   grid CRS, `crs` (default EPSG:3857), optional `areaPath` and `outPath`
mcx_grid_to_dtm <- function(request_path, response_path = NULL) {
  mcx_env$log <- character(0)
  started <- Sys.time()
  if (is.null(response_path)) {
    response_path <- paste0(tools::file_path_sans_ext(request_path), ".response.json")
  }

  out <- tryCatch(
    {
      req <- jsonlite::fromJSON(request_path, simplifyVector = TRUE)
      width <- as.integer(req$width)
      height <- as.integer(req$height)
      if (is.na(width) || is.na(height) || width < 2 || height < 2) {
        mcx_stop("The elevation grid must be at least 2 x 2 cells.")
      }
      if (is.null(req$gridPath) || !file.exists(req$gridPath)) {
        mcx_stop("The elevation grid file is missing.")
      }
      expected <- as.numeric(width) * height
      n_bytes <- file.info(req$gridPath)$size
      if (n_bytes != expected * 4) {
        mcx_stop("The elevation grid has ", n_bytes, " bytes; expected ",
                 expected * 4, " for ", width, " x ", height, " Float32 cells.")
      }

      values <- readBin(req$gridPath, what = "numeric", n = expected, size = 4,
                        endian = "little")
      values[is.nan(values)] <- NA_real_
      grid_crs <- mcx_pick(req, "crs", "EPSG:3857")

      r <- terra::rast(matrix(values, nrow = height, ncol = width, byrow = TRUE),
                       crs = grid_crs)
      terra::ext(r) <- terra::ext(req$xmin, req$xmax, req$ymin, req$ymax)

      centre <- sf::st_sfc(sf::st_point(c((req$xmin + req$xmax) / 2,
                                          (req$ymin + req$ymax) / 2)),
                           crs = sf::st_crs(grid_crs))
      lonlat <- sf::st_coordinates(sf::st_transform(centre, 4326))
      epsg <- mcx_utm_epsg(lonlat[1, 1], lonlat[1, 2])
      mcx_log("Projecting a ", width, " x ", height, " grid from ", grid_crs,
              " to EPSG:", epsg)

      # Keep the cell size the tiles actually had at this latitude, rather than
      # terra's default guess, so the DTM resolution matches the zoom chosen.
      mercator_res <- (req$xmax - req$xmin) / width
      true_res <- mercator_res * cos(lonlat[1, 2] * pi / 180)
      r <- terra::project(r, paste0("EPSG:", epsg), method = "bilinear",
                          res = true_res)

      area_path <- mcx_pick(req, "areaPath", NULL)
      if (!is.null(area_path) && file.exists(area_path)) {
        area <- sf::st_read(area_path, quiet = TRUE)
        if (nrow(area) > 0) {
          if (is.na(sf::st_crs(area))) sf::st_crs(area) <- 4326
          area <- sf::st_transform(sf::st_make_valid(sf::st_union(area)), paste0("EPSG:", epsg))
          area_v <- terra::vect(sf::st_as_sf(sf::st_sfc(area, crs = sf::st_crs(paste0("EPSG:", epsg)))))
          r <- terra::mask(terra::crop(r, area_v), area_v)
        }
      }
      names(r) <- "dtm"

      keep_as <- mcx_pick(req, "keepAs", NULL)
      out_path <- mcx_pick(req, "outPath", NULL)
      if (!is.null(keep_as) && nzchar(keep_as)) {
        mcx_env$dtms[[keep_as]] <- r
        out_bytes <- 0
        out_path <- NULL
      } else {
        if (is.null(out_path)) out_path <- file.path(dirname(request_path), "dem.tif")
        terra::writeRaster(r, out_path, overwrite = TRUE, gdal = c("COMPRESS=DEFLATE"))
        out_bytes <- file.info(out_path)$size
      }

      e84 <- terra::project(terra::ext(r), from = terra::crs(r), to = "EPSG:4326")
      finite <- terra::values(r, mat = FALSE)
      finite <- finite[!is.na(finite)]

      list(
        ok = TRUE,
        path = out_path,
        handle = keep_as,
        bytes = out_bytes,
        crs = paste0("EPSG:", epsg),
        zoom = mcx_pick(req, "zoom", NA_integer_),
        width = terra::ncol(r),
        height = terra::nrow(r),
        resolution = as.numeric(terra::res(r))[1],
        elevation = list(
          min = if (length(finite)) min(finite) else NA_real_,
          max = if (length(finite)) max(finite) else NA_real_
        ),
        bounds = list(west = terra::xmin(e84), south = terra::ymin(e84),
                      east = terra::xmax(e84), north = terra::ymax(e84)),
        elapsedSeconds = as.numeric(difftime(Sys.time(), started, units = "secs")),
        log = mcx_env$log
      )
    },
    error = function(e) list(ok = FALSE, error = conditionMessage(e), log = mcx_env$log)
  )

  jsonlite::write_json(out, response_path, auto_unbox = TRUE, null = "null",
                       na = "null", digits = 8)
  invisible(response_path)
}

#' Summarise a DTM for display on the map.
#'
#' Returns the same raster payload shape the analyses use, so the plugin can
#' paint the terrain with the machinery it already has instead of decoding a
#' GeoTIFF in the browser. Works for a downloaded DEM and an uploaded one alike.
#'
#' @param request_path JSON with `dtmPath` and an optional `maxCells`
mcx_preview_dtm <- function(request_path, response_path = NULL) {
  mcx_env$log <- character(0)
  mcx_env$target_crs <- NULL
  if (is.null(response_path)) {
    response_path <- paste0(tools::file_path_sans_ext(request_path), ".response.json")
  }

  out <- tryCatch(
    {
      mcx_require()
      req <- jsonlite::fromJSON(request_path, simplifyVector = TRUE)
      r <- mcx_resolve_dtm(req, reproject = TRUE)
      if (is.null(r)) mcx_stop("No DTM to preview.")
      mcx_env$target_crs <- sf::st_crs(terra::crs(r))

      values <- terra::values(r, mat = FALSE)
      finite <- values[!is.na(values)]
      # A preview only has to look right on screen, so it is capped well below
      # the analysis limit — a 4000 x 4000 DTM would otherwise ship 64 MB.
      payload <- mcx_raster_payload(
        r, "terrain",
        max_cells = as.numeric(mcx_pick(req, "maxCells", 250000))
      )

      list(
        ok = TRUE,
        crs = as.character(mcx_env$target_crs$input),
        width = terra::ncol(r),
        height = terra::nrow(r),
        resolution = as.numeric(terra::res(r))[1],
        elevation = list(
          min = if (length(finite)) min(finite) else NA_real_,
          max = if (length(finite)) max(finite) else NA_real_
        ),
        raster = payload,
        log = mcx_env$log
      )
    },
    error = function(e) list(ok = FALSE, error = conditionMessage(e), log = mcx_env$log)
  )

  jsonlite::write_json(out, response_path, auto_unbox = TRUE, null = "null",
                       na = "null", digits = 8)
  invisible(response_path)
}

# --- entry point -------------------------------------------------------------

#' Run one movecost analysis described by a JSON request file.
#'
#' @param request_path path to the JSON request
#' @param response_path where to write the JSON response; defaults to
#'   `<request>.response.json`
#' @return the response path, invisibly
mcx_run <- function(request_path, response_path = NULL) {
  mcx_env$log <- character(0)
  mcx_env$target_crs <- NULL
  started <- Sys.time()
  if (is.null(response_path)) {
    response_path <- paste0(tools::file_path_sans_ext(request_path), ".response.json")
  }

  out <- tryCatch(
    {
      mcx_require()
      req <- jsonlite::fromJSON(request_path, simplifyVector = TRUE)
      params <- if (is.null(req$params)) list() else as.list(req$params)
      analysis <- req$analysis
      if (is.null(analysis)) mcx_stop("The request has no 'analysis' field.")

      # Terrain arrives one of two ways: a DTM the caller supplies, or a study
      # area that movecost itself resolves into elevation through elevatr. The
      # second is movecost's own documented path (`studyplot` + `z`), so it is
      # passed straight through rather than reimplemented here.
      dtm_rast <- mcx_resolve_dtm(
        req,
        reproject = !identical(mcx_pick(params, "autoReproject", TRUE), FALSE)
      )
      has_dtm <- !is.null(dtm_rast)

      if (has_dtm) {
        target_crs <- sf::st_crs(terra::crs(dtm_rast))
        mcx_env$target_crs <- target_crs
        # movecost 2.x is built on raster/sp, so hand it a RasterLayer.
        terrain <- list(dtm = raster::raster(dtm_rast))
      } else {
        if (is.null(req$studyplotPath) || !file.exists(req$studyplotPath)) {
          mcx_stop("Supply either a DTM or a study area to download elevation for.")
        }
        if (!requireNamespace("elevatr", quietly = TRUE)) {
          mcx_stop("Downloading elevation needs the R package 'elevatr'.")
        }
        # Slope must be computed on a grid in metres, so the study area is
        # projected first: elevatr returns elevation in the CRS it is given.
        plot_sf <- sf::st_read(req$studyplotPath, quiet = TRUE)
        if (nrow(plot_sf) == 0) mcx_stop("The study area has no features.")
        if (is.na(sf::st_crs(plot_sf))) sf::st_crs(plot_sf) <- 4326
        plot_sf <- sf::st_transform(plot_sf, 4326)
        centroid <- sf::st_coordinates(sf::st_centroid(sf::st_union(plot_sf)))
        epsg <- mcx_utm_epsg(centroid[1, 1], centroid[1, 2])
        target_crs <- sf::st_crs(epsg)
        mcx_env$target_crs <- target_crs
        zoom <- as.integer(mcx_pick(params, "zoom", 12))
        if (is.na(zoom) || zoom < 1 || zoom > 14) mcx_stop("Zoom level must be between 1 and 14.")
        mcx_log("No DTM supplied; movecost will download elevation at zoom ", zoom,
                " in EPSG:", epsg)
        terrain <- list(
          dtm = NULL,
          studyplot = mcx_as_spatial(sf::st_transform(plot_sf, target_crs)),
          z = zoom
        )
      }

      origin_sf  <- mcx_read_vector(req$originPath, target_crs, "Origin")
      destin_sf  <- mcx_read_vector(req$destinPath, target_crs, "Destination")
      barrier_sf <- mcx_read_vector(req$barrierPath, target_crs, "Barrier")

      origin  <- mcx_as_spatial(origin_sf)
      destin  <- mcx_as_spatial(destin_sf)
      barrier <- mcx_as_spatial(barrier_sf)

      if (is.null(origin)) mcx_stop("Every analysis needs at least one origin point.")

      result <- switch(analysis,
        paths = {
          if (is.null(destin)) mcx_stop("The least-cost path analysis needs destination points.")
          mcx_analysis_paths(terrain, origin, destin, barrier, params)
        },
        corridor = {
          if (is.null(destin)) mcx_stop("The corridor analysis needs a second location.")
          mcx_analysis_corridor(terrain, origin, destin, barrier, params)
        },
        network = {
          if (nrow(origin_sf) < 2) mcx_stop("The network analysis needs at least two locations.")
          mcx_analysis_network(terrain, origin, barrier, params)
        },
        allocation = {
          if (nrow(origin_sf) < 2) mcx_stop("The allocation analysis needs at least two origins.")
          mcx_analysis_allocation(terrain, origin, params)
        },
        boundary = mcx_analysis_boundary(terrain, origin, barrier, params),
        rank = {
          if (is.null(destin)) mcx_stop("The ranking analysis needs a destination point.")
          mcx_analysis_rank(terrain, origin, destin, barrier, params)
        },
        mcx_stop("Unknown analysis: ", analysis)
      )

      result$rasters <- Filter(Negate(is.null), result$rasters)
      result$vectors <- Filter(Negate(is.null), result$vectors)

      list(
        ok = TRUE,
        analysis = analysis,
        crs = as.character(sf::st_crs(target_crs)$input),
        elapsedSeconds = as.numeric(difftime(Sys.time(), started, units = "secs")),
        versions = mcx_version(),
        log = mcx_env$log,
        result = result
      )
    },
    error = function(e) {
      list(
        ok = FALSE,
        error = conditionMessage(e),
        log = mcx_env$log,
        elapsedSeconds = as.numeric(difftime(Sys.time(), started, units = "secs"))
      )
    }
  )

  jsonlite::write_json(
    out, response_path,
    auto_unbox = TRUE, null = "null", na = "null", digits = 8
  )
  invisible(response_path)
}
