#!/usr/bin/env bash
# Headless smoke for **集成终端**(`main/terminal/{shellResolve,TerminalManager}.ts` +
# `main/ipc/terminal.ts`)。
#
# ## 三条安全前提(这套脚本能跑的前提)
#
#  1. **数据根是 `mktemp -d` 出来的**(`MCODE_SMOKE_DATA_ROOT`),跑完就删。桩
#     `stubs/dataRoot.ts` **没设环境变量就抛** —— `initDb()` 在不存在的路径上会新建
#     一个空库,指错地方就是拿空库盖掉用户的聊天记录。
#     本套真的建库(项目行要落盘,`isKnownWorkspaceRoot` 靠它)。
#  2. **不真起一个交互式 shell。** 那会挂着等输入直到超时。§7 那一段真起进程,但用的
#     是 `cmd /c chcp` / `cmd /c echo` 这种**立刻结束**的命令。
#  3. **不碰用户的任何东西。** 项目根是 `mktemp -d` 里的一个目录;唯一的"真"进程是
#     一个 `cmd.exe /c`,它跑完就退。
#
# ## ⚠️ 别名里最要紧的一条:`--external:node-pty` + bundle 旁边的替身包
#
# `TerminalManager` 拿 node-pty 走的是 `loadNodePty()` 里那句**运行期**
# `require("node-pty")`,而 esbuild 的 `--alias:` **只改写静态 import、管不到它**
# (实测:加了 `--alias:node-pty=…` 之后 bundle 里那句 `require("node-pty")` 原样还在,
# 于是它去磁盘上找**真的** node-pty,也就是真的 ConPTY)。
#
# 真 node-pty 有两个问题:冷启动实测 3 秒以上(本套要建十几个终端),而且坏路径是抛在
# 原生层、本套验不到"抛了之后下发给界面的那行字"。
#
# 所以改成:标 `--external:node-pty`,然后在 bundle 旁边放一份**自己的**
# `node_modules/node-pty/`。`createRequire(import.meta.url)` 解析时先看 bundle 自己
# 所在目录的 node_modules,于是一路吃到替身。替身与 `stubs/nodePty.ts` 通过
# `globalThis` 上的同一个账本见面(见 `stubs/nodePty.ts` 的头注:两份模块实例是这套
# 写法最容易踩死的坑)。
#
# §7 要**真的** node-pty,所以下面顺手把真包的绝对路径算出来传进去 ——
# `require.resolve` 从 `apps/desktop/src/main/` 出发,与 `TerminalManager` 那句同源。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-terminal-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-terminal-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# ── 真 node-pty 的绝对路径(给 §7 用) ──
# ⚠️ **不能写 `node -e "…'$PWD/src/main/'…"`** —— 在 git-bash 里 `$PWD` 是 MSYS 形态
# (`/d/destop/…`),而 Node 的 `createRequire` 认不出那个形状,于是**静默解析不到**
# (它 catch 了错、吐了个空串),§7 那一段就变成"没验"。这里改用 `cd` + `-p`,让 Node
# 自己在 Windows 形态的 cwd 上解析。
# 起点是 `src/main/` —— 与 TerminalManager 里 `createRequire(import.meta.url)` 那句
# 同一个解析起点,所以它拿到的就是 app 真正会吃到的那一份。
REAL_PTY=$(cd src/main && node -p "try{require.resolve('node-pty')}catch(e){''}" 2>/dev/null || echo "")
if [[ -z "$REAL_PTY" ]]; then
  echo "⚠️  解析不到真 node-pty —— §7 那一段会 FAIL(那是故意的:装不上的话整个终端功能在"
  echo "    真实 app 里也是坏的,静默跳过会给出'全绿'的假象)。"
fi

"$ESBUILD" scripts/terminal-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/terminal-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/terminal-smoke/stubs/runtimeManager.ts \
  --external:node-pty \
  --outfile="$OUT/smoke.mjs" --log-level=error

# ⚠️ **没有 `--alias:@main/terminal/envRefresh.js`** —— 那一条在这里**必然失效**:
# `TerminalManager` 写的是相对 import(`from "./envRefresh.js"`),而 `--alias:` 不收
# 相对路径的名字(mcode-smoke/SKILL.md 记过这一条)。硬换的话会得到两句都错的结果:
# alias 报 `Invalid alias name`,或者打包出一份**独立的** envRefresh,而
# TerminalManager 用的还是真的那个 —— 断言红得跟被测代码无关。
#
# 不换它也**不慢**:它是 10 秒 TTL 的缓存(见那个文件的 `REGISTRY_ENV_TTL_MS`),
# 本套建十几个终端只会在第一次付一次 powershell.exe 的钱。而且 `envRefresh.ts` 本来
# 就有自己的套件(`scripts/agent-env-smoke`,smokes-for 里认这个边)。

# ── bundle 旁边的 node-pty:**替身包** ──
# 这是 `loadNodePty()` 那句运行期 require 会命中的那一份。脚本实体在
# `stubs/pty-stub-package.cjs`(那里写了它为什么必须是个"包"而不是普通桩),
# 这里只是把它摆到解析顺序会先撞上的位置。
mkdir -p "$OUT/node_modules/node-pty"
printf '{ "name": "node-pty", "version": "0.0.0-terminal-smoke", "main": "index.js" }\n' \
  > "$OUT/node_modules/node-pty/package.json"
cp scripts/terminal-smoke/stubs/pty-stub-package.cjs "$OUT/node_modules/node-pty/index.js"

export MCODE_SMOKE_DATA_ROOT="$DATA"
export MCODE_SMOKE_REAL_NODE_PTY="$REAL_PTY"

node "$OUT/smoke.mjs"
