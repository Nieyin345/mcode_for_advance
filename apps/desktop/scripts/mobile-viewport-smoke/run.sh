#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/mobile-viewport-smoke/main.mjs
