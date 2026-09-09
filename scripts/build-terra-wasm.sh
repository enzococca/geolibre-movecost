#!/usr/bin/env bash
# Build terra for WebAssembly against the same webR toolchain the plugin loads,
# and lay the result out as a CRAN repository the plugin can install from.
#
#   bash scripts/build-terra-wasm.sh
#   PACKAGES="terra raster gdistance movecost" bash scripts/build-terra-wasm.sh
#
# Only terra is built by default, and that is the point: everything else in the
# movecost stack already has a working binary on repo.r-wasm.org — `sf` loads
# there, and `raster`, `gdistance` and `movecost` fail only because they import
# terra. webR falls back to the upstream repository for anything this one does
# not carry, so replacing the single broken package is enough, and it turns an
# hours-long build of the whole dependency closure into a short one.
#
# See docs/TERRA-WASM.md for why this exists and what to do with the output.
set -euo pipefail
cd "$(dirname "$0")/.."

WEBR_VERSION="${WEBR_VERSION:-0.6.0}"
PACKAGES="${PACKAGES:-terra}"
IMAGE="${WEBR_IMAGE:-ghcr.io/r-wasm/webr:main}"
OUT="build/wasm-repo"
CACHE="build/wasm-cache"

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
echo "== output            : $OUT"
echo

mkdir -p "$OUT" "$CACHE"

# Three things this gets right that are easy to get wrong:
#
#   * The repository directory is an ARGUMENT to add_pkg, not an option. Passing
#     it any other way silently builds into the container's own ./repo, which
#     then disappears with the container.
#   * add_pkg builds into a container-local directory and the result is copied
#     to the mounted volume afterwards. Building straight onto a Docker Desktop
#     bind mount fails with "Failed to set permissions for directory".
#   * `dependencies = NA` means Depends, Imports and LinkingTo only. TRUE also
#     pulls Suggests, which for terra alone resolves to 68 packages — sf,
#     leaflet and the rest of its optional world, none of which needs rebuilding.
#   * PKG_SYSREQS=false stops pak installing terra's *system* requirements
#     (gdal-bin, libgdal-dev, libgeos-dev, libproj-dev, libsqlite3-dev). We are
#     cross-compiling to WebAssembly against the wasm sysroot already in the
#     image, so the host copies are useless — and the `apt-get update` they
#     trigger fails in this image, taking the whole pak subprocess with it and
#     leaving terra to fail with "dependency 'Rcpp' is not available".
#
# The build cache is mounted too, so a re-run after a failure resumes instead of
# recompiling from scratch.
"$runtime" run --rm \
  -v "$PWD/$OUT:/opt/out" \
  -v "$PWD/$CACHE:/root/.cache" \
  -e "MCX_PACKAGES=$PACKAGES" \
  -e "PKG_SYSREQS=false" \
  -e "PKG_SYSREQS_UPDATE=false" \
  -e "PROJ_WORKAROUND=${PROJ_WORKAROUND:-1}" \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail

    # Work around a mismatch in the webR wasm sysroot — see docs/TERRA-WASM.md.
    #
    # `gdal-config --cflags` there passes -DPROJ_RENAME_SYMBOLS, so terra compiles
    # its PROJ calls as internal_proj_create and friends. Those live inside
    # libgdal.a with hidden visibility, while the standalone libproj.a exports the
    # plain names — so the calls stay unresolved, Emscripten turns each into a
    # stub, and library(terra) dies with "resolved is not a function".
    #
    # Cancelling the define outright breaks the link instead (it also renames
    # terra own bundled GeographicLib routines, which then collide with PROJ
    # copies). So the define stays, and only the seven PROJ entry points terra
    # calls directly are mapped back to their plain names; -lproj then satisfies
    # them. The mutual proj_create -> internal_proj_create -> proj_create
    # expansion terminates because the preprocessor never re-expands a macro
    # inside its own expansion.
    #
    # The flags go into rwasm own vars file: rwasm sets R_MAKEVARS_USER to
    # <rwasm>/webr-vars.mk, so ~/.R/Makevars is never read. PROJ_WORKAROUND=0
    # builds without any of this (reproduces the upstream failure);
    # PROJ_WORKAROUND=undef tries the blunt -U variant.
    VARS=$(R -q --no-echo -e "cat(system.file(\"webr-vars.mk\", package=\"rwasm\"))" 2>/dev/null || true)
    case "${PROJ_WORKAROUND:-1}" in
      0) echo "PROJ workaround disabled" ;;
      undef)
        printf "\nCPPFLAGS += -UPROJ_RENAME_SYMBOLS\nCXXFLAGS += -UPROJ_RENAME_SYMBOLS\n" >> "$VARS"
        echo "Patched $VARS with -UPROJ_RENAME_SYMBOLS" ;;
      *)
        if [ -z "$VARS" ] || [ ! -f "$VARS" ]; then
          echo "ERROR: could not find rwasm webr-vars.mk to patch." >&2; exit 1
        fi
        MAP=""
        for sym in proj_create proj_destroy proj_context_set_search_paths \
                   proj_context_is_network_enabled proj_context_set_enable_network \
                   proj_context_set_url_endpoint proj_context_get_url_endpoint; do
          MAP="$MAP -Dinternal_${sym}=${sym}"
        done
        printf "\nCPPFLAGS +=%s\nCXXFLAGS +=%s\nLIBS += -lproj\n" "$MAP" "$MAP" >> "$VARS"
        echo "Patched $VARS: PROJ entry points mapped to plain names, -lproj added" ;;
    esac

    R -q -e "
      pkgs <- strsplit(Sys.getenv(\"MCX_PACKAGES\"), \" +\")[[1]]
      pkgs <- pkgs[nzchar(pkgs)]
      rwasm::add_pkg(pkgs, repo_dir = \"/build/repo\", dependencies = NA)
    "
    mkdir -p /opt/out
    cp -R /build/repo/. /opt/out/
    echo
    echo "Repository contents:"
    find /opt/out -name "*.tgz" -print
  '

echo
# add_pkg only *warns* when a package fails to build, so check that every
# package actually asked for produced a binary rather than trusting the exit
# code — otherwise a run that built nothing but a dependency looks like success.
missing=""
for pkg in $PACKAGES; do
  if [ -z "$(find "$OUT" -name "${pkg}_*.tgz" -print -quit)" ]; then
    missing="$missing $pkg"
  fi
done
if [ -n "$missing" ]; then
  echo "Build failed for:$missing" >&2
  echo "No wasm binary was produced for them. Search the log above for the" >&2
  echo "compiler error, or for 'Building wasm binary for package'." >&2
  exit 1
fi

echo "Repository written to $OUT:"
find "$OUT" -name '*.tgz' -exec basename {} \;
echo
echo "Serve it over HTTPS with CORS, then point the plugin at it:"
echo "  localStorage.setItem(\"MOVECOST_WASM_REPO\", \"https://your-host/wasm-repo\")"
