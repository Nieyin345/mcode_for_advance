#!/usr/bin/env bash
# settings-form-lifecycle-smoke — 【MC-047】设置行的读/存生命周期(loading/ready/error/retry)。
#
# 与 browser-tabs-a11y-smoke 同一套极小 React 运行时(`--alias:react=`),把真
# ShellSection / ScreenshotDirRow / DataDirRow / PersistLoginRow 逐节当根挂载;
# `lib/api.js` 换成可按 key 注入读/写失败的桩。不起浏览器、不写盘。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-settings-form-lifecycle.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/settings-form-lifecycle-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/settings-form-lifecycle-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/settings-form-lifecycle-smoke/jsxRuntime.ts \
  --alias:react-dom=./scripts/ime-enter-smoke/reactDomStub.ts \
  --alias:@tabler/icons-react=./scripts/settings-form-lifecycle-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/settings-form-lifecycle-smoke/api-stub.ts \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
