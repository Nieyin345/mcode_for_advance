#!/usr/bin/env bash
# preview-panel-smoke — 右栏预览顶栏那颗「回 PDF」按钮印错了文字(见 main.ts 文件头)。
#
# ⚠️ 关键 alias:
#   - `react` / `react/jsx-runtime` → 极小 hooks 运行时(PreviewPanel 源码原样跑)。
#   - `@renderer/components/library/PreviewPanel.js` → 临时改写过的副本(只把相对 import
#     `./FilePreview.js` 换成 `@pp/FilePreview`,函数体一字不动;原文件若变了这段会报错)。
#   - `@renderer/stores/libraryStore.js` / `@renderer/lib/i18n/index.js` / 图标 → 桩。
#
# 不起服务、不碰磁盘。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-preview-panel.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo 'Missing local esbuild; no network install' >&2; exit 2; fi

# 复制真 PreviewPanel,只把相对 import 换成 alias —— 函数体必须保持原样。
node - "$OUT/PreviewPanel.tsx" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
let source = readFileSync('src/renderer/components/library/PreviewPanel.tsx', 'utf8');
const before = 'from "./FilePreview.js"';
if (!source.includes(before)) throw Error('PreviewPanel FilePreview import changed: update the isolated test');
source = source.replace(before, 'from "@pp/FilePreview"');
writeFileSync(process.argv[2], source);
NODE

"$ESBUILD" scripts/preview-panel-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/preview-panel-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/preview-panel-smoke/jsxRuntime.ts \
  --alias:@tabler/icons-react=./scripts/preview-panel-smoke/iconsStub.cjs \
  --alias:@renderer/lib/icons.js=./scripts/preview-panel-smoke/iconsStub.cjs \
  --alias:@renderer/components/library/PreviewPanel.js="$OUT/PreviewPanel.tsx" \
  --alias:@pp/FilePreview=./scripts/preview-panel-smoke/filePreviewStub.ts \
  --alias:@renderer/stores/libraryStore.js=./scripts/preview-panel-smoke/libraryStoreStub.ts \
  --alias:@renderer/lib/i18n/index.js=./scripts/preview-panel-smoke/i18n.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
