#!/usr/bin/env bash
# Headless production FileEditor routing/toolbar regression; no user data or editor mounts.
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/markdown-mode-smoke/main.mjs
