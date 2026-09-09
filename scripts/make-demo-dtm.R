# Builds the fixture the browser harness uses: a small synthetic DTM plus a set
# of WGS84 points derived from its own extent, so the demo never hardcodes
# coordinates that drift out of the raster.
#
#   Rscript scripts/make-demo-dtm.R
suppressPackageStartupMessages({
  library(terra)
  library(sf)
  library(jsonlite)
})

out <- "examples/public"
dir.create(out, recursive = TRUE, showWarnings = FALSE)

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
values(r) <- 300 +
  400 * exp(-((xr - 0.25)^2 + (yr - 0.30)^2) / 0.02) +
  350 * exp(-((xr - 0.75)^2 + (yr - 0.70)^2) / 0.025) -
  150 * exp(-((xr - 0.5)^2 + (yr - 0.5)^2) / 0.15)

writeRaster(r, file.path(out, "dtm.tif"), overwrite = TRUE)

# Sample positions as fractions of the extent, then express them in WGS84.
frac <- rbind(
  c(0.08, 0.08), c(0.85, 0.10), c(0.45, 0.88),
  c(0.92, 0.90), c(0.12, 0.92)
)
e <- ext(r)
pts <- st_as_sf(
  data.frame(
    id = c("O1", "O2", "O3", "D1", "D2"),
    x = e$xmin + frac[, 1] * (e$xmax - e$xmin),
    y = e$ymin + frac[, 2] * (e$ymax - e$ymin)
  ),
  coords = c("x", "y"), crs = 32633
)
pts84 <- st_transform(pts, 4326)
coords <- st_coordinates(pts84)

write_json(
  list(
    crs = "EPSG:4326",
    points = lapply(seq_len(nrow(coords)), function(i) {
      list(id = pts84$id[i], lng = coords[i, 1], lat = coords[i, 2])
    })
  ),
  file.path(out, "points.json"),
  auto_unbox = TRUE, digits = 8
)

cat("Wrote", file.path(out, "dtm.tif"), "and points.json\n")

bbox <- as.vector(ext(project(r, "EPSG:4326")))
cat("WGS84 extent:", paste(round(bbox, 5), collapse = ", "), "\n")
