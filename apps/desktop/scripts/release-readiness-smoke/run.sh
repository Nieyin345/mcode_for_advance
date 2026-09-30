#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "$0")/run.cjs"
node "$(dirname "$0")/check-window.cjs"
node "$(dirname "$0")/check-libraries.cjs"
