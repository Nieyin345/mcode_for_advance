#!/usr/bin/env bash
# T01 ARC-005 U1; real Electron capture + provenance-preserving comparison.
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/arc005-visual-baseline/build.mjs
# Exit code 2 means real, unregistered differences were FOUND, not that the
# screenshots/JSON are invalid. Keep evidence instead of suppressing the diff.
if node scripts/arc005-visual-baseline/compare.mjs; then
  echo 'arc005 visual compare: no unregistered differences'
else
  rc=$?
  if [[ "$rc" -ne 2 ]]; then exit "$rc"; fi
  echo 'arc005 visual compare: unregistered differences detected (see .tmp/arc005-visual/diff.md)'
fi
