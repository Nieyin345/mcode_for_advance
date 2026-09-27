#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/maint-m12-smoke/build.mjs
