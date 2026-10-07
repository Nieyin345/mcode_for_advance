#!/usr/bin/env bash
# Headless smoke for `main/ipc/mcp.ts` —— 设置面板「MCP 服务器」那 9 条通道
# (830 行、零覆盖)。见 main.ts 的文件头:为什么存在、换了哪些桩、哪些故意不验。
#
# ## 三个环境变量,少一个都可能在用户真实的 ~/.mcode 里写字
#
#   MCODE_SMOKE_DATA_ROOT   —— sql.js 的库;`SettingRepo.set` 内部就是 persist(),
#                              **重写整个文件**,指错地方就是拿空库盖掉聊天记录。
#   MCODE_SMOKE_CONFIG_DIR  —— 那条路上有四处往 `~/.mcode` 写东西:
#                              `.claude.json`(claude 引擎视图,每次保存/开关都重写)、
#                              `mcp-engines.json`(per-engine 矩阵)、
#                              `mcp-needs-auth-cache.json`(OAuth 徽章)、
#                              `.credentials.json`(OAuth 令牌,只读)。
#   HOME / USERPROFILE      —— **假的**,同时还决定了两个角落:
#                              宿主 Node 的 `homedir()`(导入功能只读的
#                              `~/.claude.json` 从这儿算)与 codex 视图落点
#                              (`~/.mcode/codex/config.toml`,`materializeAllMcpViews`
#                              的第二个消费点)。
#
# 还有第四样:**`@main/lib/dataRoot.js` 也换成了桩**(复用 run-store-smoke 那份)。
# 不换的话它会走到 `app.getPath("home")` → `~/Mcode` —— 那是**用户主目录下的
# Mcode 文件夹**,不是临时目录。所以 electron 桩里的 `getPath` 只实现 `userData`
# (那正是 logger 要的),别的名字一律显式抛,而 dataRoot 由桩接管到 `$DATA`。
#
# 桩里"没设就抛"的有三处:dataRoot / electron 的 userData / 下面的 REAL_HOME。
# 指错地方宁可当场崩,也不会静默改写用户的真实配置。
#
# ## ⚠️ `@main/window.js` **不换桩**,是故意的
#
# `mcp-ipc.ts` 的 import 图里,`@main/terminal/TerminalManager.js` 那一支会经
# `@main/window.js` → `@main/lib/theme.js` 拉 electron。最初的直觉是"把 window 也换了",
# 但那样本套跑的就是一个记名替身,而不是真的窗口广播实现。
#
# 实际做法是**从中间把它掐断**:整份换掉 `TerminalManager`(它只提供 `loadNodePty()`,
# 本套验不到原生插件),`window.ts` 因此整条不进来 —— 于是这里跑的是真 window。
# 只换终端会是**打地鼠**:window → lib/theme 自己还有 `nativeTheme`。
set -euo pipefail
cd "$(dirname "$0")/../.."

# `$(dirname "$0")` 在 Windows 上是相对路径,而下面的 esbuild 用的是 cd 之后的相对
# 目标 —— 先把工作目录钉死在 apps/desktop,后面所有路径都以它为基准。
DESKTOP="$PWD"
OUT=$(mktemp -d /tmp/mcode-mcp-ipc-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-mcp-ipc-data.XXXXXX)
# 夹具里那份 `~/.mcode`(以及假的 HOME)。**就是它替掉了用户的 ~/.mcode。**
fake_home=$(mktemp -d /tmp/mcode-mcp-ipc-home.XXXXXX)
HOME="$fake_home" USERPROFILE="$fake_home" mkdir -p "$fake_home/.mcode"
trap 'rm -rf "$OUT" "$DATA" "$fake_home"' EXIT

# ⚠️ **`--banner` 那一行非有不可**:sql.js 的 asm 构建里有 `require("node:fs")` /
# `require("node:crypto")`,而定死的 ESM 输出**没有 `require`** —— esbuild 会把它换成
# 一句 `throw new Error('Dynamic require of "node:fs" is not supported')`。
# 本套真的建 sql.js 库(不是内存桩),所以这一行是能不能跑起来的前提。
source "$(dirname "$0")/../lib/esbuild-path.sh"

# ## ⚠️ 假 HOME 是**唯一一件替掉用户 `~/.mcode` 的东西** —— 别把它删了
#
# `ipc/mcp.ts` 不 import electron 时到底从哪儿算 `MCODE_CONFIG_DIR`?
# `customEnv.ts` 里就是一句 `path.join(homedir(), ".mcode")`,**模块级求值**。
# 所以把 `HOME`/`USERPROFILE` 指到临时目录,那四个受管文件
# (`.claude.json` / `mcp-engines.json` / `mcp-needs-auth-cache.json` / `.credentials.json`)
# 就整体搬进了临时目录 —— **不需要给 customEnv 换桩**。
#
# 试过的那条岔路(别走):把 `@main/lib/mcpConfig.js` 也 alias 掉,好让桩里有一份
# "自己版本的 customEnv"。不行 —— `ipc/mcp.ts` 里的 import 全是**裸说明符**
# (`@main/lib/mcpConfig.js`),而 `configDir.ts` 拉真 customEnv 只能用**相对路径**,
# 于是同一个文件在 esbuild 眼里是两个模块说明符 → 两份实例 → "保存成功但列表里没有"。
# 这正是 SKILL 里那条"换桩后大面积变红先怀疑两份实例"。
#
# main.ts 第 0 节因此断言的是**真的那个模块**给出的值,不是某个桩的返回值:
# `MCODE_CONFIG_DIR` 必须落在假 HOME 里,**并且**和四个受管路径逐字对得上。
"$ESBUILD" scripts/mcp-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/mcp-ipc-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcp-ipc-smoke/stubs/pluginManager.ts \
  --alias:@main/terminal/TerminalManager.js=./scripts/mcp-ipc-smoke/stubs/terminalManager.ts \
  --alias:node-pty=./scripts/mcp-ipc-smoke/stubs/nodePty.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# 给 bundle 一个 node_modules 视野:若干模块在**运行期**从 bundle 自己位置解析依赖
# (同 library-trash-smoke / claude-ipc-smoke 那一行)。
ln -s "$DESKTOP/node_modules" "$OUT/node_modules"

# 真的 `~/.mcode` 在**改之前**长什么样 —— main.ts 的第 0 节靠它判断此刻用的到底是不是
# 临时目录(在那里读 `homedir()` 是没用的,读到的已经是下面这个改过的值)。
REAL_HOME_BEFORE="${USERPROFILE:-${HOME:-}}"

HOME="$fake_home" USERPROFILE="$fake_home" \
  MCODE_SMOKE_REAL_HOME="$REAL_HOME_BEFORE" \
  MCODE_SMOKE_DATA_ROOT="$DATA" \
  node "$OUT/smoke.mjs"
