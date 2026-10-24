#!/usr/bin/env bash
# panel-frame-version-smoke — PanelFrame 的换版竞态(台账 UI-016,见 main.ts 文件头)。
#
# ⚠️ 关键 alias:
#   - `react` / `react/jsx-runtime` → 极小运行时(带稳定 contentWindow 的假 iframe)。
#   - `@renderer/lib/api.js` → **能扣住 stage 回包**的替身。
#   - `@renderer/lib/i18n/index.js` / `platform.js` → 桩。
#   - PanelFrame 的**相对 import** `./panelBridge.js` / `./panelReadback.js` 用 --alias
#     换不掉(相对说明符不收)—— 沿用 preview-panel-smoke 的手法:把真 PanelFrame 复制到
#     $OUT,只把那两条相对 import 换成 alias 名,函数体一字不动。
#
# 不起服务、不碰磁盘。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-panel-frame-version.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "${ESBUILD:-}" ]]; then echo 'Missing local esbuild; no network install' >&2; exit 2; fi

# 复制真 PanelFrame,只把两条相对 import 换成 alias —— 函数体必须保持原样。
node - "$OUT/PanelFrame.tsx" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
let source = readFileSync('src/renderer/components/customUi/PanelFrame.tsx', 'utf8');
for (const [before, after] of [
  ['from "./panelBridge.js"', 'from "@pfbridge"'],
  ['from "./panelReadback.js"', 'from "@pfreadback"'],
]) {
  if (!source.includes(before)) throw Error(`PanelFrame import changed: ${before} (update the isolated test)`);
  source = source.replace(before, after);
}
writeFileSync(process.argv[2], source);
NODE

"$ESBUILD" scripts/panel-frame-version-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/panel-frame-version-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/panel-frame-version-smoke/jsxRuntime.ts \
  --alias:@renderer/lib/api.js=./scripts/panel-frame-version-smoke/api-stub.ts \
  --alias:@renderer/lib/i18n/index.js=./scripts/panel-frame-version-smoke/i18nStub.ts \
  --alias:@renderer/lib/platform.js=./scripts/panel-frame-version-smoke/platformStub.ts \
  --alias:@pfbridge=./scripts/panel-frame-version-smoke/panelBridgeStub.ts \
  --alias:@pfreadback=./scripts/panel-frame-version-smoke/panelReadbackStub.ts \
  --alias:@renderer/components/customUi/PanelFrame.js="$OUT/PanelFrame.tsx" \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
