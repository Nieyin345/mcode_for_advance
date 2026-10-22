#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# T23 gap A: prove the PRODUCTION config emits the document view preload.
# electron-vite/vite are resolved from apps/desktop/node_modules (dev deps of
# the desktop package), matching how `electron-vite build` loads the config.
node scripts/production-build-preload-smoke/main.mjs
