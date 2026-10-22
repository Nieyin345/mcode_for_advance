#!/usr/bin/env bash
set -euo pipefail
# T25: vendor product freshness — read-only over genoffice/apps/*/out.
node "$(dirname "$0")/main.cjs"
