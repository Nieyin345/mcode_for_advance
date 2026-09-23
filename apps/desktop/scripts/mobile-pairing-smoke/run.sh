#!/usr/bin/env bash
# Headless smoke for **手机端那道门**(配对 / 令牌 / HTTP 服务 —— `main/mobile/`)。
#
# 这是唯一一套**真的起 HTTP 服务**的冒烟:路由表与鉴权闸门住在
# `MobileHttpServer.startMobileServer` 的请求回调里,而那个函数 `listen(port, "0.0.0.0")`
# —— 直接调它等于把跑测试的这台机器挂到局域网上。所以路由表被**逐字提取**成
# `createMobileRequestHandler(endpoint)`(见 MobileHttpServer 里那段注释),本套拿它
# 绑 **127.0.0.1 + 随机端口**(`listen(0, "127.0.0.1")`),打完自己关掉。
# 不打外网、不碰局域网别的机器。
#
# ⚠️ **真的建一个 sqlite 库**(令牌住在 settings 表里,那是"撤销"那条断言的存放层)。
# 数据根换成本脚本自己的 mktemp 目录(见 stubs/dataRoot.ts 里那句"没设就抛":指错地方
# 等于拿空库盖掉用户的聊天记录),跑完就删。
#
# 别名五档,理由各不相同:
#   - **electron 整个包** —— 照 library-delete-smoke / frontend-smoke 的做法。`main/`
#     下有一堆**直接**写 `import { … } from "electron"` 的文件(secretStore /
#     BrowserManager / ipc/files …),顺着 alias 一个个堵会变成打地鼠,而每漏一个报出来的
#     都是 "No matching export";本套的 import 图比那两套都宽,所以桩里把 `main/` 里
#     出现过的**每一个**具名导入都列了出来。见 stubs/electron.ts 的文件头;
#   - dataRoot / logger —— 真的那两个 import 了 electron,db-migrate-smoke 的老桩;
#   - window —— `lib/sessionSync.ts` 拿它的 `sendToRenderer`;
#   - BrowserManager —— `ipc/library.ts` → `library/downloader.ts` → 它(下载那一路,
#     与门一个字都不沾),显式报错式替身;
#   - workflows/seed —— ⚠️ **非有不可**:seed → `workflows/searchScriptsAssets.ts` 是
#     二十几个 **Vite `?raw` 导入**的 `.py` / `LICENSE`,esbuild 会以
#     `No loader is configured for ".py" files` 直接挂掉打包;
#   - RuntimeManager —— 真那个一路拖到三个引擎实现;SSE 的 `runningSessionIds()` 由
#     脚本用 `__setRunning` 指定。
set -euo pipefail
cd "$(dirname "$0")/../.."

# 建在 apps/desktop 下,不建在 /tmp —— 与 mcp-endpoint-smoke / mcode-admin-smoke 同款。
# 理由见 mcp-endpoint-smoke 那段:外部化的包(这里新增的 `--external:ssh2`)要在运行时
# 被 node 解析到,而 `/tmp` 下的 bundle 向上走不到本包的 node_modules →
# `ERR_MODULE_NOT_FOUND: Cannot find package 'ssh2'`。这个坑是补 external 时才暴露的。
mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-mobile-pairing-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-mobile-pairing-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 有两件事要做:
#   1. 给 **sql.js** 一个真的 `require`:它的 asm 构建里有 `require("node:fs")` /
#      `require("node:crypto")`,而定死的 ESM 输出**没有 `require`** —— esbuild 会把它
#      换成一句 `throw new Error('Dynamic require of "node:fs" is not supported')`;
#   2. 给 **`serveMobileStatic`** 一个 `__dirname`:`candidateRoots()` 里的第三顺位是
#      `join(__dirname, "..", "renderer")`。CJS 里 `__dirname` 是免费的,ESM 里不是 ——
#      没有它,请求一走到静态那一路就是 `ReferenceError: __dirname is not defined`,
#      而那个错看起来和"被测代码坏了"一模一样。定成产物自己的目录,与 CJS 下同义。
BANNER="import { createRequire as __cr } from 'node:module'; \
import { fileURLToPath as __f2p } from 'node:url'; \
import { dirname as __dn } from 'node:path'; \
const require = __cr(import.meta.url); \
const __dirname = __dn(__f2p(import.meta.url));"

"$ESBUILD" scripts/mobile-pairing-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ssh2 \
  --banner:js="$BANNER" \
  --alias:electron=./scripts/mobile-pairing-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/mobile-pairing-smoke/stubs/window.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/mobile-pairing-smoke/stubs/browserManager.ts \
  --alias:@main/workflows/seed.js=./scripts/mobile-pairing-smoke/stubs/workflowsSeed.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/mobile-pairing-smoke/stubs/runtimeManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
