#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/module-phase2-e2e-smoke/build.mjs
