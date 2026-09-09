#!/usr/bin/env bash
# Local development bootstrap: install node dependencies, build the demo fixture,
# and start the browser harness on http://localhost:5174
#
#   bash scripts/dev-setup.sh          # install + fixture + serve
#   bash scripts/dev-setup.sh --serve  # just serve
set -uo pipefail
cd "$(dirname "$0")/.."

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# The CRAN build of R on macOS ships its PROJ database inside the sf package.
if [ -z "${PROJ_LIB:-}" ] && [ -d /Library/Frameworks/R.framework/Resources/library/sf/proj ]; then
  export PROJ_LIB=/Library/Frameworks/R.framework/Resources/library/sf/proj
fi

if [ "${1:-}" != "--serve" ]; then
  echo "== npm install"
  npm install --no-audit --no-fund || exit 1
  echo "== demo fixture"
  Rscript scripts/make-demo-dtm.R || echo "(fixture generation failed; the demo page will 404 on dtm.tif)"
fi

echo "== vite demo server on http://localhost:5174"
exec npx vite --config vite.demo.config.ts --host 127.0.0.1
