#!/usr/bin/env bash
# Headless smoke for `main/lsp/`(`LspManager.ts` + `languageSpecs.ts`)——
# language server 的生命周期:启动失败怎么报、找不到 server 怎么办、
# 关掉之后有没有残留进程、起不来会不会变成死循环。
#
# **不下载任何 language server**(`lsp.install` 那条路整套避开 —— 那会往用户机器上
# 装东西)。但 `ensureServer` 那条路是**真的 spawn**:本套造一个假的 server
# (node + 一帧 Content-Length 的 JSON-RPC),再用一个 `.cmd` 把它包起来 ——
# 那正是 Windows 上 npm 全局装的 server 的形状(cmd.exe 包着 node)。
# jdtls / gopls 这些真二进制一个都不需要。
#
# ⚠️ **真的建一个 sqlite 库**:`lsp.servers` 配置住在 settings 表里,而
# `SettingRepo.set` 内部就是 `persist()` —— 一次调用就重写整个 `mcode.db`。
# 数据根由 `stubs/dataRoot.ts` 从 `MCODE_SMOKE_DATA_ROOT` 取(没设就抛),
# 主脚本自己 `mktemp -d`;Java 的安装目录(`<userData>/lsp/java`)也被 electron 桩
# 引到临时目录里。
#
# 假 server 的进程清理由**主脚本自己**做(它知道自己起过哪些 pid,见 main.ts 的
# `killLeftovers`):那是为了"关掉之后还有没有残留进程"这条断言 —— 所以脚本
# 必须留到最后一刻才动手,失败退出时也要走同一条路。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-lsp-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner` 那一行是给 sql.js 的(理由同 run-store-smoke/run.sh):它的 asm 构建里有
# `require("node:fs")`,而定死的 ESM 输出没有 `require`,esbuild 会把它换成一句抛错。
#
# 别名四档:
#   - **整个 electron 包** —— `store/db.ts` 与 `lsp/LspManager.ts` 各有一句
#     `import { app } from "electron"`;桩里 `app.getPath("userData")` 返回临时目录,
#     别的 API 一律显式抛(理由见 stubs/electron.ts 的文件头);
#   - dataRoot / logger —— 复用 run-store-smoke 的老桩;
#   - window —— LspManager 用它推 `lsp:event`,本套把推出去的每一条记下来;
#   - pathGuard —— 把「哪些根算合法工作区」变成脚本里自己摆的清单。
"$ESBUILD" scripts/lsp-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/lsp-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/lsp-smoke/stubs/window.ts \
  --alias:@main/lib/pathGuard.js=./scripts/lsp-smoke/stubs/pathGuard.ts \
  --alias:@main/lib/binaryResolve.js=./scripts/lsp-smoke/stubs/binaryResolve.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
