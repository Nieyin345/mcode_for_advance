#!/usr/bin/env bash
# 【T41】`contributionsOf` 目录形状异常的**用户可见行为**回归。
#
# 这一套真渲染组件(`react-dom/server`),断言立在"用户看到的那行字"上 ——
# 要防的正是"静默":白屏和空坞都是用户看不见原因。
#
# ## 换桩
#
# 被测的三样(moduleCatalogShape.tsx 里的判据/收集/提示)是纯件,但它们经
# `@renderer/lib/i18n` 与 `@renderer/hooks/useRpc` 间接拖进 `sessionStore`,后者有一句
# 动态 `import("@renderer/lib/monacoSetup.js")` —— 裸 esbuild 解析不了 monaco 的
# `?worker` 后缀(仓库文档里记过的同一类坑)。这两条链与本次判据无关,换桩:
#   - `useRpc.js`   → 只借它的返回形状,运行时一点都用不到
#   - `i18n/index.js` → 直接回显 key,断言要验的是"提示出现了",不是译文措辞
set -euo pipefail

# ⚠️ `$0` 可能是**相对路径**（从仓库根 `bash apps/desktop/scripts/<x>-smoke/run.sh`）。
# 先把它解析成绝对路径，后面的 `cd` 就不会让 `$(dirname "$0")` 失效。
# 同 T24/T29/T30 的写法。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-module-catalog-shape-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

"$ESBUILD" scripts/module-catalog-shape-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@renderer/hooks/useRpc.js=./scripts/module-catalog-shape-smoke/stubs/useRpc.ts \
  --alias:@renderer/lib/i18n/index.js=./scripts/module-catalog-shape-smoke/stubs/i18n.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
