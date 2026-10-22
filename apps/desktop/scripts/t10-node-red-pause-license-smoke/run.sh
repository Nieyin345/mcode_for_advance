#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/t10-node-red-pause-license-smoke/main.cjs
