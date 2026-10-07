#!/usr/bin/env bash
# Headless smoke for the settings → workflows panel (batch C).
#
# Bundles scripts/workflow-view-smoke/main.ts with esbuild (tsconfig paths apply)
# and runs it in plain node with stubbed window/document/localStorage (prelude.ts).
# No electron and no DOM: the view-model functions are asserted directly, and the
# editor is rendered through react-dom/server against real documents in both
# locales. See main.ts for what is and is not covered.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-workflow-view-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

# CJS, not ESM (unlike the other smokes): `react-dom/server` is CommonJS and
# requires node builtins (`util`). Bundled to ESM that becomes esbuild's
# `__require` shim, which throws "Dynamic require of \"util\" is not supported"
# at load. CJS output keeps the real require.
#
# The session store's sole dynamic import is monacoSetup (LSP worker bootstrap),
# which drags in the whole monaco bundle + ?worker/.ttf assets that only vite can
# resolve. Nothing here reaches it (the panel renders no editor), so leave the
# specifier unresolved rather than teaching esbuild monaco's asset graph.
"$ESBUILD" scripts/workflow-view-smoke/main.ts \
  --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.cjs" --log-level=error

node "$OUT/smoke.cjs"
