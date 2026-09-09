# Entry point for the movecost HTTP backend.
#
#   Rscript r-backend/start.R
#
# Environment:
#   MOVECOST_PORT    port to listen on (default 8787)
#   MOVECOST_ENGINE  path to movecost-engine.R (default: alongside this project)
#   PROJ_LIB         set here when missing, from sf's bundled PROJ database

# --- PROJ first ---------------------------------------------------------------
# The CRAN build of R on macOS keeps its PROJ database inside the sf package.
# This has to happen before anything loads terra, whose .onLoad initialises GDAL
# and complains "Cannot find proj.db" otherwise.
if (!nzchar(Sys.getenv("PROJ_LIB"))) {
  for (pkg in c("sf", "terra")) {
    candidate <- suppressWarnings(system.file("proj", package = pkg))
    if (nzchar(candidate) && file.exists(file.path(candidate, "proj.db"))) {
      Sys.setenv(PROJ_LIB = candidate)
      break
    }
  }
}

# --- locate the engine --------------------------------------------------------
# plumber::pr() runs the API file with the working directory set to that file's
# folder, so the engine path is resolved here, absolutely, and handed over in an
# environment variable.
this_file <- local({
  args <- commandArgs(trailingOnly = FALSE)
  hit <- grep("^--file=", args, value = TRUE)
  if (length(hit)) normalizePath(sub("^--file=", "", hit[1])) else NA_character_
})
project_root <- if (is.na(this_file)) getwd() else dirname(dirname(this_file))

engine_path <- Sys.getenv("MOVECOST_ENGINE", "")
if (!nzchar(engine_path)) {
  engine_path <- file.path(project_root, "src", "engine", "movecost-engine.R")
}
if (!file.exists(engine_path)) {
  stop("Cannot find movecost-engine.R at '", engine_path,
       "'. Set MOVECOST_ENGINE to its path.", call. = FALSE)
}
Sys.setenv(MOVECOST_ENGINE = normalizePath(engine_path))

api_path <- file.path(project_root, "r-backend", "plumber.R")
if (!file.exists(api_path)) {
  stop("Cannot find r-backend/plumber.R next to '", engine_path, "'.", call. = FALSE)
}

# --- dependencies -------------------------------------------------------------
required <- c("plumber", "jsonlite", "sf", "terra", "raster", "sp", "movecost")
# elevatr powers "draw an area and download a DEM"; `progress` is one of its
# soft dependencies that is genuinely needed at call time, so check it here
# rather than letting the first download fail with a bare namespace error.
optional <- c(elevatr = "elevatr", progress = "progress")

missing <- Filter(function(p) !requireNamespace(p, quietly = TRUE), required)
if (length(missing)) {
  stop(
    "Missing R packages: ", paste(missing, collapse = ", "), "\n",
    'Install them with: install.packages(c("', paste(missing, collapse = '", "'), '"))',
    call. = FALSE
  )
}

missing_optional <- Filter(function(p) !requireNamespace(p, quietly = TRUE), optional)
if (length(missing_optional)) {
  message(
    "Note: elevation download is unavailable — missing ",
    paste(missing_optional, collapse = ", "), ".\n",
    '      install.packages(c("', paste(missing_optional, collapse = '", "'), '"))\n',
    "      Everything else works; load a GeoTIFF instead."
  )
}

port <- as.integer(Sys.getenv("MOVECOST_PORT", "8787"))
cat("movecost backend\n")
cat("  engine : ", Sys.getenv("MOVECOST_ENGINE"), "\n", sep = "")
cat("  PROJ_LIB: ", Sys.getenv("PROJ_LIB"), "\n", sep = "")
cat("  listening on http://127.0.0.1:", port, "\n", sep = "")
cat("  health  : curl http://127.0.0.1:", port, "/health\n", sep = "")

plumber::pr_run(plumber::pr(api_path), host = "127.0.0.1", port = port)
