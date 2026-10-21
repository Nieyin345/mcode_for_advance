#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/t73-browser-sandbox-smoke/run.cjs
# Real Electron is deliberately opt-in: serialise it with other Electron suites.
if [[ "${MCODE_T73_ELECTRON:-0}" == "1" ]]; then
  node scripts/t73-browser-sandbox-smoke/native.cjs
fi
