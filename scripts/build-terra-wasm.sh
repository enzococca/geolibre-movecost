#!/usr/bin/env bash
# Build terra (and the packages that link against it) for WebAssembly, against
# the same webR toolchain the plugin loads, and lay the result out as a CRAN
# repository the plugin can install from.
#
#   bash scripts/build-terra-wasm.sh
#   WEBR_VERSION=0.6.0 PACKAGES="terra raster gdistance movecost" bash scripts/build-terra-wasm.sh
#
# See docs/TERRA-WASM.md for why this exists and what to do with the output.
set -euo pipefail
cd "$(dirname "$0")/.."

WEBR_VERSION="${WEBR_VERSION:-0.6.0}"
PACKAGES="${PACKAGES:-terra raster gdistance movecost}"
IMAGE="${WEBR_IMAGE:-ghcr.io/r-wasm/webr:main}"
OUT="build/wasm-repo"

runtime=""
for candidate in docker podman; do
  if command -v "$candidate" >/dev/null 2>&1; then runtime="$candidate"; break; fi
done
if [ -z "$runtime" ]; then
  echo "Neither docker nor podman is on PATH. Install one, then re-run." >&2
  exit 1
fi

echo "== container runtime : $runtime"
echo "== toolchain image   : $IMAGE"
echo "== webR version      : $WEBR_VERSION"
echo "== packages          : $PACKAGES"
echo

mkdir -p "$OUT"

# rwasm::add_pkg() compiles each package with the emscripten toolchain already
# present in the image and writes a CRAN-shaped tree under repo/.
"$runtime" run --rm \
  -v "$PWD/$OUT:/opt/out" \
  -e "MCX_PACKAGES=$PACKAGES" \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    R -q -e "if (!requireNamespace(\"rwasm\", quietly=TRUE)) install.packages(\"rwasm\", repos=c(\"https://r-wasm.r-universe.dev\", \"https://cloud.r-project.org\"))"
    R -q -e "
      pkgs <- strsplit(Sys.getenv(\"MCX_PACKAGES\"), \" +\")[[1]]
      pkgs <- pkgs[nzchar(pkgs)]
      options(rwasm.repo_dir = \"/opt/out\")
      rwasm::add_pkg(pkgs, dependencies = TRUE)
      rwasm::make_vignette_index(\"/opt/out\")
    "
  '

echo
echo "Repository written to $OUT"
echo "Serve it over HTTPS with CORS, then point the plugin at it:"
echo "  localStorage.setItem(\"MOVECOST_WASM_REPO\", \"https://your-host/wasm-repo\")"
