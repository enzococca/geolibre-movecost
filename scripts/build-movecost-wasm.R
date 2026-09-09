# =============================================================================
# Package movecost for webR without compiling anything.
#
#   Rscript scripts/build-movecost-wasm.R [version]
#
# movecost 3.0.0 is `NeedsCompilation: no`: it is R code and data, no shared
# object. The archive webR installs is simply the installed package directory,
# and R's lazy-load databases are portable across platforms and word sizes, so
# a package with no compiled code installed by any R 4.6 works unchanged inside
# WebAssembly. Only the `Built:` metadata has to be restamped, so that webR and
# `available.packages()` see an emscripten build rather than a macOS one.
#
# The result is dropped into build/wasm-repo alongside the rebuilt terra and
# the repository index is regenerated. Everything else keeps coming from
# repo.r-wasm.org.
# =============================================================================

args <- commandArgs(trailingOnly = TRUE)
version <- if (length(args)) args[1] else "3.0.0"
repo_dir <- "build/wasm-repo/bin/emscripten/contrib/4.6"
stopifnot(dir.exists(dirname(dirname(dirname(dirname(repo_dir))))))
dir.create(repo_dir, recursive = TRUE, showWarnings = FALSE)

work <- file.path(tempdir(), "mcx-wasm-pkg")
unlink(work, recursive = TRUE)
lib <- file.path(work, "lib")
dir.create(lib, recursive = TRUE)

cat("== downloading movecost", version, "source\n")
src <- utils::download.packages("movecost", destdir = work,
                                repos = "https://cloud.r-project.org", type = "source")
tarball <- src[1, 2]
got <- sub("^movecost_", "", sub("\\.tar\\.gz$", "", basename(tarball)))
if (!identical(got, version)) {
  stop("CRAN currently offers movecost ", got, ", not ", version)
}

cat("== installing into a scratch library (no compilation involved)\n")
out <- system2("R", c("CMD", "INSTALL", "--no-test-load", "--no-help",
                      paste0("--library=", shQuote(lib)), shQuote(tarball)),
               stdout = TRUE, stderr = TRUE)
if (!dir.exists(file.path(lib, "movecost"))) {
  stop(paste(out, collapse = "\n"))
}
if (dir.exists(file.path(lib, "movecost", "libs"))) {
  stop("movecost ", version, " ships compiled code; this shortcut no longer applies")
}

cat("== restamping the build metadata as emscripten\n")
desc_path <- file.path(lib, "movecost", "DESCRIPTION")
desc <- readLines(desc_path)
stamp <- format(Sys.time(), "%Y-%m-%d %H:%M:%S UTC", tz = "UTC")
built <- paste0("Built: R ", getRversion(), "; wasm32-unknown-emscripten; ", stamp, "; unix")
desc <- c(desc[!grepl("^Built:", desc)], built)
writeLines(desc, desc_path)

meta_path <- file.path(lib, "movecost", "Meta", "package.rds")
meta <- readRDS(meta_path)
meta$Built$Platform <- "wasm32-unknown-emscripten"
meta$Built$OStype <- "unix"
saveRDS(meta, meta_path, version = 2)

cat("== writing the archive\n")
target <- normalizePath(repo_dir, mustWork = TRUE)
tgz <- file.path(target, paste0("movecost_", version, ".tgz"))
old <- setwd(lib)
utils::tar(tgz, "movecost", compression = "gzip", tar = "internal")
setwd(old)

tools::write_PACKAGES(target, type = "mac.binary", latestOnly = FALSE)
cat("== repository now carries:\n")
print(utils::available.packages(paste0("file://", target), type = "mac.binary")[, c("Package", "Version")])
cat("\n", tgz, " (", format(file.info(tgz)$size / 1024, digits = 4), " KB)\n", sep = "")
