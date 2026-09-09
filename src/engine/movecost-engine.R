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
# The cost graph mc_surface() builds, kept between runs so that changing only
# the points does not rebuild it. One at a time — see mcx_build_surface().
mcx_env$surface <- NULL
mcx_env$surface_key <- NULL

mcx_log <- function(...) {
  msg <- paste0(...)
  mcx_env$log <- c(mcx_env$log, msg)
  invisible(msg)
}

mcx_stop <- function(...) stop(paste0(...), call. = FALSE)

# --- environment -------------------------------------------------------------

mcx_version <- function() {
  version_of <- function(pkg) {
    if (requireNamespace(pkg, quietly = TRUE)) {
      as.character(utils::packageVersion(pkg))
    } else {
      NA_character_
    }
  }
  list(
    r = paste0(R.version$major, ".", R.version$minor),
    movecost = version_of("movecost"),
    terra = version_of("terra"),
    sf = version_of("sf"),
    igraph = version_of("igraph")
  )
}

mcx_require <- function() {
  needed <- c("movecost", "sf", "terra", "jsonlite")
  missing <- needed[!vapply(needed, requireNamespace, logical(1), quietly = TRUE)]
  if (length(missing)) {
    mcx_stop("Missing R packages: ", paste(missing, collapse = ", "))
  }
  # movecost 3.0.0 (CRAN, June 2026) replaced the per-analysis functions with a
  # compute-once API: mc_surface() builds the cost graph and mc_paths() and its
  # siblings reuse it. This engine speaks that API, and 2.x has no equivalent,
  # so an old installation is named here rather than left to fail somewhere
  # inside a function that does not exist.
  version <- utils::packageVersion("movecost")
  if (version < "3.0.0") {
    mcx_stop(
      "This plugin needs movecost 3.0.0 or later; the installed version is ",
      as.character(version), '. Update it with: install.packages("movecost")'
    )
  }
  invisible(TRUE)
}

# Nothing in the mc_* API draws: movecost 3.0 moved plotting into plot()
# methods, so the analyses no longer need a null graphics device around them.
# Start-up chatter would still land in the response, so calls still go through
# here.
mcx_quietly <- function(expr) {
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

# movecost 3.0 takes sf objects directly, so nothing is coerced to sp any more.
# The points still need at least one attribute column: it is what the plugin
# labels them with on the map, and what the costs come back attached to.
mcx_ensure_id <- function(v) {
  if (is.null(v)) {
    return(NULL)
  }
  keep <- setdiff(names(v), attr(v, "sf_column"))
  if (!length(keep)) v$mcx_id <- seq_len(nrow(v))
  v
}

#' A data frame jsonlite can serialise.
#'
#' movecost 3.0 returns measured columns as `units` objects — boundary areas in
#' m^2, path lengths in m — and jsonlite has no method for those. The Rd pages
#' name the unit of every such column, so the class is simply stripped and the
#' number travels plain.
mcx_plain_table <- function(x) {
  if (is.null(x)) {
    return(NULL)
  }
  df <- as.data.frame(x)
  for (i in seq_along(df)) {
    col <- df[[i]]
    if (inherits(col, "units") || inherits(col, "difftime")) {
      df[[i]] <- as.numeric(col)
    } else if (!is.atomic(col)) {
      df[[i]] <- as.character(col)
    }
  }
  df
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
  # Drop columns sf cannot serialise (lists, matrices) before writing, and
  # strip the `units` class off the measured ones so GeoJSON gets bare numbers.
  drop <- vapply(sf::st_drop_geometry(v), function(col) !is.atomic(col), logical(1))
  if (any(drop)) v <- v[, !c(drop, FALSE), drop = FALSE]
  for (nm in setdiff(names(v), attr(v, "sf_column"))) {
    if (inherits(v[[nm]], "units") || inherits(v[[nm]], "difftime")) {
      v[[nm]] <- as.numeric(v[[nm]])
    }
  }
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

#' Finite numbers from a parameter that may arrive as a list, a string, or not
#' at all. Returns NULL rather than an empty vector so callers can just test it.
mcx_numeric <- function(params, name) {
  v <- mcx_pick(params, name, NULL)
  if (is.null(v) || !length(v)) {
    return(NULL)
  }
  v <- suppressWarnings(as.numeric(unlist(v)))
  v <- v[is.finite(v)]
  if (!length(v)) NULL else v
}

# Everything mc_surface() needs. In movecost 2.x these travelled with every
# analysis call; in 3.0 they define the cost graph, which is built once and
# then read by all the analyses.
mcx_surface_args <- function(params) {
  list(
    funct     = mcx_pick(params, "funct", "t"),
    move      = as.integer(mcx_pick(params, "move", 16)),
    field     = as.numeric(mcx_pick(params, "field", 0)),
    cogn.slp  = isTRUE(mcx_pick(params, "cognSlope", FALSE)),
    topo.dist = isTRUE(mcx_pick(params, "topoDist", FALSE)),
    sl.crit   = as.numeric(mcx_pick(params, "slCrit", 10)),
    W         = as.numeric(mcx_pick(params, "W", 70)),
    L         = as.numeric(mcx_pick(params, "L", 0)),
    N         = as.numeric(mcx_pick(params, "N", 1)),
    V         = as.numeric(mcx_pick(params, "V", 1.2))
  )
}

# Cost functions whose output is a duration; only these care about `time`.
MCX_TIME_FUNCTIONS <- c(
  "t", "tofp", "mp", "icmonp", "icmoffp", "icfonp", "icfoffp",
  "ug", "ma", "alb", "gkrs", "r", "ks", "trp"
)

mcx_is_time_function <- function(funct) funct %in% MCX_TIME_FUNCTIONS

mcx_time_unit <- function(params) {
  if (identical(mcx_pick(params, "time", "h"), "m")) "m" else "h"
}

mcx_call <- function(fun, args) {
  mcx_quietly(do.call(fun, args))
}

# --- the cost surface --------------------------------------------------------

# The one expensive step. mc_surface() turns the DTM into a directed graph of
# per-cell movement costs, and every analysis reads that graph rather than
# rebuilding it. Runs that differ only in their points — another destination,
# a second cost limit — therefore cost a Dijkstra pass instead of a full
# rebuild, which is the whole reason the 3.0 API is shaped this way.
#
# Exactly one surface is kept. Inside webR the graph is the largest object in
# the heap, so the previous one is dropped and collected before a new one is
# built, never held alongside it.
mcx_surface_signature <- function(source_key, barrier_key, args) {
  paste(
    c(source_key, barrier_key,
      vapply(args, function(v) paste(as.character(v), collapse = ","), character(1))),
    collapse = "|"
  )
}

mcx_forget_surface <- function() {
  mcx_env$surface <- NULL
  mcx_env$surface_key <- NULL
  invisible(NULL)
}

mcx_build_surface <- function(source, barrier, barrier_key, params) {
  args <- mcx_surface_args(params)
  signature <- mcx_surface_signature(source$key, barrier_key, args)
  if (!is.null(mcx_env$surface) && identical(mcx_env$surface_key, signature)) {
    mcx_log("Reusing the cost surface already built for these settings")
    return(mcx_env$surface)
  }
  mcx_forget_surface()
  invisible(gc(full = TRUE))

  call_args <- c(list(dtm = source$dtm), args)
  if (is.null(source$dtm)) {
    call_args$studyplot <- source$studyplot
    call_args$z <- source$zoom
  }
  if (!is.null(barrier)) call_args$barrier <- barrier

  mcx_log("Building the cost surface (", args$funct, ", ", args$move, " directions)")
  surface <- mcx_call(movecost::mc_surface, call_args)
  mcx_env$surface <- surface
  mcx_env$surface_key <- signature
  surface
}

# --- analyses ----------------------------------------------------------------

mcx_analysis_paths <- function(surface, origin, destin, params) {
  time <- mcx_time_unit(params)
  res <- mcx_call(movecost::mc_paths, list(
    surface = surface, origin = origin, destin = destin,
    return.base = isTRUE(mcx_pick(params, "returnBase", FALSE)),
    time = time
  ))
  # The accumulated cost surface and its isolines are a separate call in 3.0.
  # The plugin has always drawn them next to the paths, and with the graph
  # already built the second call is cheap.
  acc_args <- list(surface = surface, origin = origin, time = time)
  breaks <- mcx_numeric(params, "breaks")
  if (!is.null(breaks)) acc_args$breaks <- breaks[1]
  acc <- mcx_call(movecost::mc_accum, acc_args)

  list(
    vectors = list(
      lcps         = mcx_sf_to_geojson(res$paths),
      lcpsBack     = mcx_sf_to_geojson(res$paths.back),
      isolines     = mcx_sf_to_geojson(acc$isolines),
      destinations = mcx_sf_to_geojson(res$destin)
    ),
    rasters = list(
      accumulated = mcx_raster_payload(acc$accum, "accumulated_cost"),
      costSurface = mcx_raster_payload(surface$cost.raster, "cost_surface")
    ),
    tables = list(
      destinations = mcx_plain_table(
        if (!is.null(res$destin)) sf::st_drop_geometry(res$destin) else NULL
      )
    )
  )
}

mcx_analysis_corridor <- function(surface, a, b, params) {
  method <- mcx_pick(params, "corridorMethod", "reach")
  if (!method %in% c("reach", "through")) method <- "reach"
  res <- mcx_call(movecost::mc_corridor, list(
    surface = surface, a = a, b = b,
    method = method,
    lcp = TRUE,
    rescale = isTRUE(mcx_pick(params, "rescale", FALSE)),
    time = mcx_time_unit(params)
  ))

  list(
    vectors = list(
      lcpAtoB = mcx_sf_to_geojson(res$lcp.AtoB),
      lcpBtoA = mcx_sf_to_geojson(res$lcp.BtoA)
    ),
    rasters = list(
      corridor = mcx_raster_payload(res$corridor, "least_cost_corridor")
    )
  )
}

mcx_analysis_network <- function(surface, nodes, params) {
  type <- mcx_pick(params, "netwType", "allpairs")
  if (!type %in% c("allpairs", "neigh")) type <- "allpairs"
  res <- mcx_call(movecost::mc_network, list(
    surface = surface, nodes = nodes,
    type = type,
    density = isTRUE(mcx_pick(params, "lcpDensity", FALSE)),
    time = mcx_time_unit(params)
  ))

  list(
    vectors = list(
      network = mcx_sf_to_geojson(res$paths),
      nodes = mcx_sf_to_geojson(res$nodes)
    ),
    rasters = list(
      density = mcx_raster_payload(res$density.perc, "lcp_density_percent")
    ),
    tables = list(
      costMatrix = mcx_plain_table(res$cost.matrix)
    )
  )
}

mcx_analysis_allocation <- function(surface, origin, params) {
  args <- list(surface = surface, origin = origin, time = mcx_time_unit(params))
  breaks <- mcx_numeric(params, "breaks")
  if (!is.null(breaks)) args$breaks <- breaks[1]
  res <- mcx_call(movecost::mc_alloc, args)

  list(
    vectors = list(
      boundaries = mcx_sf_to_geojson(res$zones),
      isolines = if (isTRUE(mcx_pick(params, "isolines", FALSE))) {
        mcx_sf_to_geojson(res$isolines)
      } else {
        NULL
      }
    ),
    rasters = list(
      allocation = mcx_raster_payload(res$alloc, "cost_allocation")
    )
  )
}

mcx_analysis_boundary <- function(surface, origin, params) {
  limits <- mcx_numeric(params, "contValue")
  if (is.null(limits)) {
    mcx_stop("The boundary analysis needs at least one cost limit.")
  }
  time <- mcx_time_unit(params)
  # mc_boundary() takes one limit per call. Several are still worth offering —
  # the one-hour and the two-hour walk on the same map — and with the graph
  # already built each extra limit costs only its own pass over it.
  parts <- lapply(limits, function(limit) {
    mcx_call(movecost::mc_boundary, list(
      surface = surface, origin = origin, limit = limit, time = time
    ))
  })
  boundaries <- do.call(rbind, lapply(parts, function(p) p$boundaries))

  list(
    vectors = list(
      boundaries = mcx_sf_to_geojson(boundaries)
    ),
    rasters = list(
      accumulated = mcx_raster_payload(parts[[1]]$accum, "accumulated_cost")
    ),
    tables = list(
      boundaries = mcx_plain_table(
        if (!is.null(boundaries)) sf::st_drop_geometry(boundaries) else NULL
      )
    )
  )
}

mcx_analysis_rank <- function(surface, origin, destin, params) {
  res <- mcx_call(movecost::mc_rank, list(
    surface = surface, origin = origin, destin = destin,
    k = as.integer(mcx_pick(params, "lcpN", 3)),
    penalty = as.numeric(mcx_pick(params, "penalty", 0.01)),
    time = mcx_time_unit(params)
  ))

  list(
    vectors = list(
      rankedPaths = mcx_sf_to_geojson(res$paths)
    ),
    rasters = list(
      corridor = mcx_raster_payload(res$corridor, "least_cost_corridor")
    ),
    tables = list(
      paths = mcx_plain_table(
        if (!is.null(res$paths)) sf::st_drop_geometry(res$paths) else NULL
      )
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
      rm(values)
      terra::ext(r) <- terra::ext(req$xmin, req$xmax, req$ymin, req$ymax)

      # Belt and braces behind the panel's own budget: a grid over `maxCells`
      # is averaged down before projection, so an oversized request degrades
      # to a coarser DTM instead of exhausting the heap.
      max_cells <- as.numeric(mcx_pick(req, "maxCells", NA_real_))
      if (is.finite(max_cells) && max_cells > 0 && expected > max_cells) {
        fact <- ceiling(sqrt(expected / max_cells))
        mcx_log("Grid of ", expected, " cells exceeds the ", max_cells,
                "-cell budget; aggregating by ", fact)
        r <- terra::aggregate(r, fact = fact, fun = "mean", na.rm = TRUE)
        width <- terra::ncol(r)
        height <- terra::nrow(r)
      }

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
        # One DTM at a time: inside webR every kept raster stays in the wasm
        # heap, and a handful of downloads over a session is what turns a
        # comfortable run into "cannot allocate". The panel only ever refers
        # to the latest handle.
        mcx_env$dtms <- list()
        mcx_env$dtms[[keep_as]] <- r
        # A new DTM invalidates the cached cost graph, and holding both at once
        # is exactly what exhausts the wasm heap.
        mcx_forget_surface()
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
    error = function(e) list(ok = FALSE, error = mcx_memory_hint(conditionMessage(e)), log = mcx_env$log)
  )
  invisible(gc(full = TRUE))

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
      # second is mc_surface()'s own documented path (`studyplot` + `z`), so it
      # is passed straight through rather than reimplemented here.
      dtm_rast <- mcx_resolve_dtm(
        req,
        reproject = !identical(mcx_pick(params, "autoReproject", TRUE), FALSE)
      )

      if (!is.null(dtm_rast)) {
        target_crs <- sf::st_crs(terra::crs(dtm_rast))
        mcx_env$target_crs <- target_crs
        # movecost 3.0 takes a SpatRaster directly; the raster/sp round-trip
        # the 2.x engine needed is gone.
        source <- list(
          dtm = dtm_rast,
          key = paste0(
            "dtm:", mcx_pick(req, "dtmHandle", ""), ":", mcx_pick(req, "dtmPath", ""),
            ":", terra::ncol(dtm_rast), "x", terra::nrow(dtm_rast)
          )
        )
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
        source <- list(
          dtm = NULL,
          studyplot = sf::st_transform(plot_sf, target_crs),
          zoom = zoom,
          key = paste0("area:", req$studyplotPath, ":", zoom, ":", epsg)
        )
      }

      origin_sf  <- mcx_ensure_id(mcx_read_vector(req$originPath, target_crs, "Origin"))
      destin_sf  <- mcx_ensure_id(mcx_read_vector(req$destinPath, target_crs, "Destination"))
      barrier_sf <- mcx_read_vector(req$barrierPath, target_crs, "Barrier")

      if (is.null(origin_sf)) mcx_stop("Every analysis needs at least one origin point.")

      # Checked before the surface is built: a missing destination should not
      # cost the user a full graph construction first.
      switch(analysis,
        paths = if (is.null(destin_sf)) mcx_stop("The least-cost path analysis needs destination points."),
        corridor = if (is.null(destin_sf)) mcx_stop("The corridor analysis needs a second location."),
        rank = if (is.null(destin_sf)) mcx_stop("The ranking analysis needs a destination point."),
        network = if (nrow(origin_sf) < 2) mcx_stop("The network analysis needs at least two locations."),
        allocation = if (nrow(origin_sf) < 2) mcx_stop("The allocation analysis needs at least two origins."),
        boundary = invisible(NULL),
        mcx_stop("Unknown analysis: ", analysis)
      )

      # Barriers now belong to the surface rather than to each analysis, so
      # every analysis honours them — including allocation and ranking, which
      # movecost 2.x could not.
      barrier_key <- paste0("barrier:", mcx_pick(req, "barrierPath", ""),
                            ":", as.numeric(mcx_pick(params, "field", 0)))
      surface <- mcx_build_surface(source, barrier_sf, barrier_key, params)

      result <- switch(analysis,
        paths = mcx_analysis_paths(surface, origin_sf, destin_sf, params),
        corridor = mcx_analysis_corridor(surface, origin_sf, destin_sf, params),
        network = mcx_analysis_network(surface, origin_sf, params),
        allocation = mcx_analysis_allocation(surface, origin_sf, params),
        boundary = mcx_analysis_boundary(surface, origin_sf, params),
        rank = mcx_analysis_rank(surface, origin_sf, destin_sf, params),
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
        error = mcx_memory_hint(conditionMessage(e)),
        log = mcx_env$log,
        elapsedSeconds = as.numeric(difftime(Sys.time(), started, units = "secs"))
      )
    }
  )
  # The transition matrices and cost surfaces are large and out of scope now;
  # inside webR the heap they held is only reusable once R has collected them.
  invisible(gc(full = TRUE))

  jsonlite::write_json(
    out, response_path,
    auto_unbox = TRUE, null = "null", na = "null", digits = 8
  )
  invisible(response_path)
}

# R's out-of-memory errors name the size, never the remedy.
mcx_memory_hint <- function(msg) {
  if (grepl("cannot allocate|memory exhausted|out of memory|Cannot enlarge memory", msg,
            ignore.case = TRUE)) {
    paste0(msg, " (the DTM is too large for the memory available: use a coarser ",
           "detail level or a smaller area, or 8 movement directions instead of 16)")
  } else {
    msg
  }
}
