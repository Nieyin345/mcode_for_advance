#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
cd "$ROOT/apps/desktop"
node build/stage-theia-resources.cjs
node "$HERE/main.cjs"
