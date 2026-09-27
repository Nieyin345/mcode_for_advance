#!/usr/bin/env bash
# MAINT-2026-09 / M17: memory review must not delete files that still have an
# unsaved editor draft. Renders the real MemoryExplorerPanel +
# MemoryMaintenanceReview in an owned headless Chromium (temp profile, random
# port, killed on exit) against in-page mock RPC — no IPC, no user data.
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/maint-m17-smoke/build.mjs
