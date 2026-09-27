#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/module-workflow-smoke/build.mjs
# Keep the shared save/import integration gap visible to run-smokes --all.
node scripts/module-workflow-smoke/build.mjs --save-guard
