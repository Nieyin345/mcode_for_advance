#!/usr/bin/env bash
# Headless smoke for the right-pane tab switcher (UI 重建 2026-10-28).
#
# Renders `PaneTabSwitcher` through react-dom/server against the real
# custom-UI config and asserts what a user would actually get:
# every tab in the registry shows up, hiding a tab in settings removes it,
# and clicking one writes BOTH `rightPanelTab` and `rightOpen`.
#
# Why SSR is enough: the switcher's logic is "which entries to show" (derived
# from `rightPanel.tab`) and "what does clicking do" (store actions). Both are
# observable without a DOM — the click handler is a plain function we can call.
# What is NOT covered: pixel layout, and whether the tile header row has room
# for the scroll strip. That is the visual baseline's job.
#
# See main.ts for the full list of what is and is not exercised.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-pane-tab-switcher.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"

# CJS, not ESM: `react-dom/server` is CommonJS and requires node builtins
# (`util`). Bundled to ESM that becomes esbuild's `__require` shim, which throws
# "Dynamic require of \"util\" is not supported" at load.
#
# monacoSetup is left external for the same reason as workflow-view-smoke: the
# session store's one dynamic import drags in monaco's ?worker/.ttf asset graph
# that only vite can resolve, and nothing here reaches it.
"$ESBUILD" scripts/pane-tab-switcher-smoke/main.ts \
  --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.cjs" --log-level=error

node "$OUT/smoke.cjs"
