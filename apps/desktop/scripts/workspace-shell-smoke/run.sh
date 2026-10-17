#!/usr/bin/env bash
# workspace-shell-smoke —— ARC-005 V1 双壳地基(ui.shell 偏好 + ClassicShell 抽取)。
#
# 渲染端混合套:前半段驱动**真的 sessionStore**(init 水合 + setShellPref 落盘),
# 用 prelude.ts 换上无头 window/document/localStorage 与可探针的 api 桩
# (同 session-store-smoke 的形状);后半段是源码断言(App.tsx / ClassicShell.tsx)。
# 不用 --alias:store 与 shellPrefs 都从源码相对/别名路径直接打包。
#
# Run: scripts/workspace-shell-smoke/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-workspace-shell.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"

# The store's sole dynamic import is monacoSetup (LSP worker bootstrap), which
# drags in monaco's ?worker/.ttf assets esbuild cannot resolve; no code path
# here reaches it (same treatment as session-store-smoke).
"$ESBUILD" scripts/workspace-shell-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
