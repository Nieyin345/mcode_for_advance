#!/usr/bin/env bash
# Headless smoke for **模版 → 资料库的一次性迁移**(`main/library/templateMigration.ts`)
# 与**模版库 IPC**(`main/ipc/templates.ts`)—— 见 main.ts 文件头。
#
# 这两块在补这套之前是零覆盖(`templates-smoke` 只跑 `templates/read.ts`),而迁移类
# 代码会改用户已有的数据。所以这里**真的建库、真的建模版目录、真的落盘**。
#
# ## 安全前提(不是洁癖,是这套能跑的前提)
#
# 数据根走 `MCODE_SMOKE_DATA_ROOT` → 本脚本 `mktemp -d` 出来的目录。桩里**没设就抛**
# (见 stubs/dataRoot.ts),因为它指向真库时 `SettingRepo.set`(内部是 `persist()`,
# 也就是把整个 `mcode.db` 重写一遍)一次就能毁掉用户的聊天记录。
#
# 模版目录也在同一个临时根下面(`<数据根>/templates/...`),不在用户的 `~/Mcode`。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-template-migration-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-template-migration-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 别名分两类,理由各不相同:
#
#   - **electron 整个包** —— `main/ipc/templates.ts` 自己就 `import { shell }`,而
#     `main/lib/reveal.ts`(它经 `openDirectory` 被引进来)也直接用它。顺着 alias
#     一个个堵会变成打地鼠。本套不起 Electron,那个桩一律**显式抛**。
#   - **dataRoot** —— 本套自己的桩(在 run-store-smoke 那份的基础上多导出一个
#     `getDataRoot`,让 main.ts 能在开跑前确认数据根真的指着临时目录)。
#   - **window** —— 真的那个拿着 BrowserWindow。本套要**断言广播**(挂进对话推了
#     什么、`templates:changed` 有没有发),所以是记录式而不是空操作。main.ts 用
#     **相对路径** import 同一份 stub,两个 bundle 看见的才是同一个数组。
#   - **RuntimeManager / BrowserManager / seed** —— `@main/mcp/libraryServer.js`
#     那条 import 图拖进来的(`library/downloader.ts` → BrowserManager,
#     `workflows/seed.ts` 里二十几个 Vite `?raw` 的 `.py`)。本套 §7 要拿那个工具表
#     比对"两个入口是不是同一个函数",所以非 import 它不可。三个桩都是显式抛式的。
#
# `--banner` 那一行**非有不可**:sql.js 的 asm 构建里有 `require("node:fs")`,而定死的
# ESM 输出没有 `require`(理由同 run-store-smoke/run.sh)。
"$ESBUILD" scripts/template-migration-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/template-migration-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/template-migration-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/template-migration-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-delete-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/library-delete-smoke/stubs/browserManager.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
