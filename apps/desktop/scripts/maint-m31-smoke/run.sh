#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
node apps/desktop/scripts/maint-m31-smoke/build.mjs
