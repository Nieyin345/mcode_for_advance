#!/usr/bin/env bash
# Headless smoke for **采纳 Markdown 这条路上的两个数据丢失**
# (`main/library/adoptMarkdown.ts` + `main/library/convert.ts`)。
#
# 为什么单独一套、而且非有不可:
#
#   1. `adoptMarkdownFile` 早先是**先删后拷**(`rmSync(整包目录)` → `copyFileSync(新的)`)。
#      中间任何一步失败(源文件读不了、磁盘满、权限、路径太长),用户**原来那一包就没了**,
#      而新的也没进来 —— 不可逆,点一下「改用这个 Markdown」原有产物静默消失。
#   2. `convertItemToMarkdown` 的**重转**永远 `force: true`,于是用户手动 adopt 进来
#      (或改过)的 Markdown 会被机器重新生成的覆盖掉。
#
# 这两条都不是"形状看出来的错",只有**真的让复制失败一次**、**真的重转一次**才看得见。
# 所以本套用 `icacls` 制造**确定性**的权限失败(见 main.ts 里 denyRead/denyWriteIn 的说明):
# 「拷到一半失败」不靠撞运气。
#
# 数据根换成本套自己的临时目录(复用 db-migrate-smoke 的 dataRoot/logger 桩)—— 它会真的
# 建库、真的往"库根"里写文件、真的删目录,指错地方就是拿空库盖掉用户的聊天记录。
#
# 别名分三档(与 library-mcp-smoke 同款,理由也一样):
#   - dataRoot / logger —— 真的那两个 import 了 electron;
#   - window / RuntimeManager —— `library/broadcast.ts` 用的(`convert.ts` → `downloader.ts`
#     → `broadcast.ts` 会拉到),真 RuntimeManager 一路拖到三个引擎实现;
#   - BrowserManager / theme / secretStore —— electron 的那一截在**下载**那条路上,本套
#     一次都不走它,但 import 图会拉到。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-adopt-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-adopt-data.XXXXXX)

# ⚠️ **给 bundle 一个 node_modules 视野。** `library/pdfText.ts` 里那句
# `require.resolve("pdfjs-dist/package.json")` 是**运行期**从 bundle 自己的位置解析的,
# 而 esbuild 把 bundle 打进了临时目录 —— 那儿没有 node_modules,本地抽取就会以
# "Cannot find module" 失败,而那看起来和"被测代码坏了"一模一样。软链一份进去
# (不设 NODE_PATH:那条路只管 CJS,而 pdf.js 自己那条动态 import 走 ESM)。
ln -s "$PWD/node_modules" "$OUT/node_modules"

# 权限注入是"手动"的(icacls 不是对称的:父目录上事后新建的子目录不会继承那个拒绝 ACE)
# —— 所以退出时必须把注入过的路径逐个反转,否则临时目录删不掉。main.ts 自己会反转它注入
# 的那几处;这里再兜一道底,免得它半路抛异常留下一个删不掉的 /tmp 目录。
cleanup() {
  for p in "$DATA/library/markdown/imported" "$DATA/library/markdown/imported"/*; do
    [[ -e "$p" ]] || continue
    icacls "$p" /remove:d "*S-1-1-0" >/dev/null 2>&1 || true
  done
  rm -rf "$OUT" "$DATA"
}
trap cleanup EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/library-adopt-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-mcp-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-import-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/library-mcp-smoke/stubs/browserManager.ts \
  --alias:@main/lib/theme.js=./scripts/library-mcp-smoke/stubs/theme.ts \
  --alias:@main/lib/secretStore.js=./scripts/library-mcp-smoke/stubs/secretStore.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
