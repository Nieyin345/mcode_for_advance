#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/module-contributions-smoke/build.mjs "$@"
if [ "$#" -eq 0 ]; then
  node scripts/module-contributions-smoke/ui-build.mjs
fi
