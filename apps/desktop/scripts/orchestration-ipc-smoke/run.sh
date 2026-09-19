#!/usr/bin/env bash
# Headless smoke for **`main/ipc/orchestration.ts`** 与 **`main/orchestration/nodeTypesSeed.ts`**
# (工作流那一摊的入口 + 铺节点类型目录)。见 main.ts 文件头。
#
# 这一套**真的注册**那 22 条 IPC(记名替身,抄 `library-trash-smoke` 的 §4),然后按
# channel 把注册进去的**真函数**调起来 —— 没有一句在复述 handler 内部的写法。
#
# ⚠️ 数据根指向 `mktemp -d`(见 stubs/dataRoot.ts 里那句"没设就抛"):这一套会建库、
# 写会话行、写运行存档,而 `SettingRepo.set` 内部就是 `persist()`,**重写整个 `mcode.db`**。
# 指向真库等于毁掉用户的聊天记录。临时目录这一条不是洁癖,是这套脚本能跑的前提。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-orch-ipc-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-orch-ipc-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")`,而定死的
# ESM 输出**没有 `require`** —— esbuild 会把它换成一句
# `throw new Error('Dynamic require of "node:fs" is not supported')`(同 run-store-smoke)。
#
# ── `--loader:` 那一组是 `?raw` 的等价物 ──────────────────────────────────────
#
# `ipc/orchestration.ts` → … → `workflows/seed.ts` 会拉到二十几个 **Vite `?raw`** 导入
# (`.py`、`.md`、`.txt`、连后缀都没有的 `LICENSE`)。纯 node 解析不了它们,而 esbuild
# 只要给了对应后缀的 loader 就能把 `x.md?raw` 解析回 `x.md` 再套 text loader
# —— 这正是本套能 import **真的** `nodeTypesSeed.ts`(它头里写着"不能被无头探针直接
# import")的原因。`--loader:=text`(空后缀)兜住 `LICENSE` 那种没有后缀的。
#
# ── 换桩的五个─────────────────────────────────────────────────────────────────
#   - `electron`   —— 真的那个是原生模块。本套要的 `dialog` 两个方法返回"用户取消了",
#                     其余一律显式抛(见 stubs/electron.ts 的文件头);
#   - `dataRoot`   —— 真的那个读 `app.getPath("userData")` 下的指针文件(指向真数据根,危险);
#   - `logger`     —— 真的那个往 `userData/logs` 写文件;
#   - `window`     —— 真的那个拿着 BrowserWindow。本套**要靠它接住广播**
#                     (`notifyWorkflowsChanged` 的全部作用就是 `sendToRenderer`),
#                     所以那个桩是记名的,不是空的;
#   - `RuntimeManager` —— 真的那个一 `bindSession` 就把三个引擎实现和每个的 MCP 工具表
#                     全拉起来,无头跑不起来。用 `frontend-smoke` 那份现成的
#                     (`automationRunner` 只要 `subscribe` / `isTurnEndHeld` 那几个成员);
#   - `pluginManager` —— 真的那个读插件目录、解压、spawn git。节点类型只要内置那一份
#                     与用户自写目录那一份。
#
# BrowserManager 不用换桩:它在 import 图里是**为了 `library/downloader.ts`**,而本套
# 一次都不走那条路。`stubs/electron.ts` 里给了它顶层要的那两个成员(`session` /
# `WebContentsView`),被调到会显式抛。
"$ESBUILD" scripts/orchestration-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --loader:.md=text --loader:.py=text --loader:.txt=text --loader:=text \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/orchestration-ipc-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/orchestration-ipc-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/frontend-smoke/stubs/runtimeManager.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/orchestration-ipc-smoke/stubs/pluginManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
