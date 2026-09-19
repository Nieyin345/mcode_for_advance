#!/usr/bin/env bash
# Headless smoke for **`main/ipc/claude.ts`** —— 主对话那条 IPC(594 行、25 个 handler、
# 零覆盖文件里最大的一个)。见 main.ts 文件头。
#
# ## 这一套的取舍:换掉"引擎那一半",留下"数据那一半"
#
# `ipc/claude.ts` 一半是**引擎的传声筒**(sendTurn / interrupt / 审批 / 撤回的参数原样
# 转给 RuntimeManager),另一半是**主进程自己的判断**。传声筒那半验了没意义;这一套全押
# 在后半:
#
#   - 覆盖值谁赢(界面说的 vs 库里存的)、什么该落盘、什么只该活在内存里
#   - 什么时候该广播、什么时候**不该**
#   - 什么时候拦住用户的消息、什么时候放行
#   - 认不出的请求 id 这条**静默**路径到底怎么走的
#
# ## ⚠️ 换桩的边界是**文件**,不是"哪一层"
#
# 这是本套最容易做错的一件事:`ipc/claude.ts` import 的**每一个**模块都可能是链上拉
# 起引擎的那一环,所以下面每一个 `--alias` 都是读了那条链之后才切的。两处差点漏掉:
#
#   - `lib/sessionSync.js` —— 它的 `sendToRenderer` 落在 `window.js` 上,而广播
#     **必须**是真的:本套好几条断言(手机端列表刷不刷新)就压在它身上。
#   - `ipc/titleGen.js` —— `sendTurn` 在首条消息上**火忘式**调它,真的那份会一路走到
#     `ipc/git.ts` → 密钥库 → 真起 `query()` 子进程。火忘 = 套件退出之后还在动。
#
# 真 sqlite 库,数据根是 `mktemp -d`。跑完连目录一起删。
#
# ⚠️ **数据根必须是 `mcode.db` 的副本。** 这一套真建库、真写会话行、真调
# `SettingRepo.set`(内部就是 `persist()`,**重写整个库文件**)。指错地方等于拿空库盖掉
# 用户的聊天记录。`stubs/dataRoot.ts` 那句"没设环境变量就抛"就是为这件事。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-claude-ipc-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-claude-ipc-data.XXXXXX)
# 给 bundle 一个 node_modules 视野:若干模块在运行期从 bundle 自己位置解析依赖
# (同 library-trash-smoke 那一行)。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 这里**只留 alias 一条路**(下面那行 `--alias:@main/orchestration/runner.js=...`),
# 不再单独打一份外置的桩、也不再 `--external` —— 理由见下面那段长注释:那两样凑在一起
# 会变成**两份模块实例**,而症状是一整片看着像源码坏了的红。

# `--banner` 那一行是给 sql.js 的:它的 asm 构建里有 `require("node:fs")`,而定死的 ESM
# 输出没有 `require`(理由同 run-store-smoke/run.sh)。
#
# ⚠️ `electron` 整包替掉,不是一个个堵。`ipc/claude.ts` 经 `lib/worktreeOps` 用到
# `app`、经 `lib/theme` 用到 `nativeTheme`、`store/db` 用到 `app` —— 顺着 alias 一个个
# 堵会变成打地鼠。
#
# ⚠️⚠️ **runner 那份桩这里踩过一次,而且是最难看出来的一种。**
#
# 最初这两行同时写着:
#     --external:./runner.js --external:./stubs/runner.js
#     --alias:@main/orchestration/runner.js=./scripts/claude-ipc-smoke/stubs/runner.ts
# 看起来是"双保险",实际是**两份模块实例**:
#   - `ipc/claude.ts` 那句 `import ... from "@main/orchestration/runner.js"` 被 alias 直接
#     内联进主 bundle,拿到一份 runner 桩;
#   - 而**本套脚本自己**那句 `from "./stubs/runner.js"` 被 `--external` 留在外面,
#     运行期加载的是旁边那份打了包的 runner.js —— 那是**另一份**。
# 于是 `setGraphRunIntent("start")` 设进 A,被测代码读的是 B(B 永远返回 null),
# 表现是 §6 §7 整片红:**"推图被调了一次 — actual 0"**、**"要停的是整张图 — actual 0"**、
# 以及本该拦住消息的地方**没抛**。每一句都像源码坏了,其实源码一行没动。
#
# 判断方法就是 SKILL 里那条:**换桩后如果大面积变红(而不是围着你的改动红),先怀疑
# 拿到了两份实例。**
#
# ## 解法:别用"外置 + external"那套,直接**让两条路解析到同一个文件**
#
# 试过、也被否掉的两条路:
#   a) 让 main.ts 直接 `import ... from "@main/orchestration/runner.js"` —— 运行时对了,
#      但 **tsc 不认**:真模块没有 `setGraphRunIntent` 这些导出,typecheck 直接红。
#      (tsc 看的是真的那个文件,esbuild 看的是 alias 之后的那个 —— 别对 tsc 撒谎。)
#   b) 外置 + `--external` —— 就是上面那两份实例。
#
# 现在是:main.ts 保持相对 import(`./stubs/runner.js`),而 alias 的目标写成**同一个
# 文件**,esbuild 解析完绝对路径发现是同一份,只实例化一次。两边天然共享状态,
# 而且**两边都不需要对 tsc 撒谎**。
"$ESBUILD" scripts/claude-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/claude-ipc-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/claude-ipc-smoke/stubs/runtimeManager.ts \
  --alias:@main/providers/registry.js=./scripts/claude-ipc-smoke/stubs/providerRegistry.ts \
  --alias:@main/ipc/titleGen.js=./scripts/claude-ipc-smoke/stubs/titleGen.ts \
  --alias:@main/orchestration/runner.js=./scripts/claude-ipc-smoke/stubs/runner.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
