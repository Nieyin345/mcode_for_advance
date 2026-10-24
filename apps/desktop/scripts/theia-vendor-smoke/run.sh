#!/usr/bin/env bash
set -euo pipefail
# F022: Theia vendor source — provenance, license, build, and source→build→runtime chain.
# Slow by design: the five-step chain rebuilds twice (~10 s incremental each).
node "$(dirname "$0")/main.cjs"
