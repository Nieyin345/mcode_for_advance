#!/usr/bin/env bash
# Compatibility entry. The pnpm and Bash commands share one implementation.
# For a small change, first consult scripts/smokes-for.sh and run named suites.
set -euo pipefail
exec node "$(dirname "$0")/run-smokes.mjs" --all
