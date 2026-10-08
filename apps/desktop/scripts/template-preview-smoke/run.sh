#!/usr/bin/env bash
# template-preview-smoke — `DocxPreview` 的 blob URL 泄漏(见 main.ts 文件头)。
#
# ⚠️ **不起服务、不碰磁盘、不装 jsdom**:`react` 换成极小 hooks 运行时,`docx-preview`
#    换成复刻了 `blobToURL` 那一支的替身,`URL` 换成记账器(见 prelude.ts)。
#
# 三个 `--alias` 是这套的关键:
#   - `react` / `react/jsx-runtime` → 本目录的极小运行时(组件源码原样跑,只换调度器)。
#   - `docx-preview` → 替身。真库那支 `useBase64URL ? data: : createObjectURL` 是
#     被判行为本身,必须照实复刻 —— 用真库反而测不到(它要一份真 docx 字节)。
#   - `@renderer/lib/icons.js` → 空壳(图标只是惰性 JSX 的 `type`,从不被调用)。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-template-preview.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/template-preview-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/template-preview-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/template-preview-smoke/jsxRuntime.ts \
  --alias:docx-preview=./scripts/template-preview-smoke/stubs/docxPreview.ts \
  --alias:@renderer/lib/i18n/index.js=./scripts/template-preview-smoke/stubs/i18n.ts \
  --alias:@renderer/lib/icons.js=./scripts/template-preview-smoke/iconsStub.cjs \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
