#!/usr/bin/env bash
# Headless smoke for **代理之间通信**(`main/lib/agentMail.ts` + `mcodeServer.ts` 那三个工具)。
#
# ## 为什么单独一套
#
# 这套东西的判定**全是"谁被允许跟谁说话"** —— 名册的范围、跨树拒绝、重名拆开、条数上限、
# 回信的路由。这些都是纯逻辑,但它们错了的样子**都不报错**:
#
#   - 名册范围放大 → 一个对话的代理能叫醒另一个项目的会话;
#   - 重名不拆 → 模型写 `to: "评审"` 投给一个不确定的对象;
#   - `re` 匹配不精确 → 一段答复投给另一个提问方,两边都以为发对了;
#   - 上限没了 → 两个代理互发到天荒地老,而界面上只是"聊个没完"。
#
# 所以这里**真建库、真写会话行、真取名册、真投递**,而不是断言"源码里写着某个字符串"
# (仓规:断言要测行为,不是文本 —— 后者在一个把函数体清空的实现上照样绿)。
#
# ## 它不碰用户真正的数据根
#
# `stubs/dataRoot.ts` 换成 `$MCODE_SMOKE_DATA_ROOT`(run.sh 用 `mktemp -d` 建的),跑完删。
# ⚠️ 这很要紧:`initDb()` 在路径不存在时会**新建一个空库**,指错了就是拿空库盖掉用户的库。
#
# ## 换桩的边界
#
#   - `dataRoot` / `logger` —— 真的那两个 import electron;
#   - `RuntimeManager` —— 真的那个一 bindSession 就把三个引擎全拉起来(见那个桩的文件头)。
# 其余全是真的:**真 sqlite 库**、真的 `agentMail`、真的 `peersOf` / `deliver` / `recordAsk`。
#
# 投递端口那一侧**用真桩注册**(见 main.ts):它按会话 id 回答"在不在跑 / 能不能叫醒",
# 并记下每一次 inject / wake —— 断言看的正是这些记录。
#
# Run: scripts/agent-mail-smoke/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

# ⚠️ **产物目录必须在 `.tmp/` 下,不能是 `/tmp`。** `--external:ssh2` 留着的那条 import
# 要由 node 在**运行时**解析,而它从产物目录**往上**找 `node_modules`。`/tmp` 在 Windows
# 上落到 `%LOCALAPPDATA%\Temp`,从那儿往上找不到仓库里的 `node_modules`(实测报
# `ERR_MODULE_NOT_FOUND: Cannot find package 'ssh2'`)。mcode-admin-smoke 用同一个位置。
# 那个目录由本脚本自己建、跑完删,`.tmp/` 已在 .gitignore 里。
mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/agent-mail-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-agent-mail-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--external:ssh2` 与 mcode-admin-smoke 同一条理由:它链上来的 `cpu-features` 是个
# 原生模块(`.node` 二进制),esbuild 解析不了;而这一套根本不碰 ssh。
#
# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")`,而固定的
# ESM 输出没有 `require`(同 session-subchat-smoke/run.sh)。
"$ESBUILD" scripts/agent-mail-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ssh2 \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/session-subchat-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/session-subchat-smoke/stubs/logger.ts \
  --alias:electron=./scripts/agent-mail-smoke/stubs/electron.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
