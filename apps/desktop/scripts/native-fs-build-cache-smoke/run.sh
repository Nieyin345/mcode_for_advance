#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/native-fs-build-cache-smoke/main.cjs
