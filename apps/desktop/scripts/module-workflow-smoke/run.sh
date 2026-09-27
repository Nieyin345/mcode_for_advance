#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/module-workflow-smoke/build.mjs
# Keep shared strict save/import validation covered by run-smokes --all.
node scripts/module-workflow-smoke/build.mjs --save-guard
