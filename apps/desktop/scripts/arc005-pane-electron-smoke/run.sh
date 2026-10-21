#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/arc005-pane-electron-smoke/build.mjs
