#!/usr/bin/env bash
# Headless smoke for `main/ipc/plugins.ts`(插件面板那 10 条 RPC 的那一层)。
#
# ## 为什么 HOME/USERPROFILE 都要改
#
# `PLUGINS_ROOT` 是从 `os.homedir()` 推出来的(`customEnv.ts` 的
# `MCODE_CONFIG_DIR`)。Node 在 win32 上**只认 USERPROFILE**(libuv 的规矩),
# POSIX 那边认 HOME —— 两个都指到临时目录,否则这套会往用户**真的**
# `~/.mcode/plugins` 里装/删插件。main.ts 第 0 节还会再断言一次,不成立就退出。
#
# ## 为什么没有 dataRoot / sql.js 那一套
#
# 这条路上被用到的设置表只有 `SettingRepo.get/set`(`pluginManager` 读写
# `plugins.enabled` / `plugins.marketplaces` / `plugins.mcpDisabled` 三个键),
# 换成内存桩就够了 —— 本套一行 sqlite 都不碰,也就没有"指错库毁聊天记录"的风险。
# 真正要防的是文件系统的那个根,上面那段管的就是它。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-plugins-ipc-smoke.XXXXXX)
SMOKE_HOME=$(mktemp -d /tmp/mcode-plugins-ipc-home.XXXXXX)
trap 'rm -rf "$OUT" "$SMOKE_HOME"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner`:sql.js 的 asm 构建里有 `require("node:fs")`,而定死的 ESM 输出没有
# `require` —— 这里其实走不到 sql.js(SettingRepo 被换了),但那行 banner 无害,
# 保留它可以让这份骨架和别的套件保持一致。
"$ESBUILD" scripts/plugins-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/store/repositories.js=./scripts/plugins-ipc-smoke/stubs/settingRepo.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/plugins-ipc-smoke/stubs/runtimeManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# `MCODE_SMOKE_REAL_HOME`:真的家 = **改之前**的那个值。main.ts 的第 0 节靠它判断
# 此刻用的到底是不是临时目录 —— 在 main.ts 里读 `homedir()` 是没用的,那读到的
# 就是下面这个已经被改过的值(第一版这么写,断言自己就没意义了)。
REAL_HOME_BEFORE="${USERPROFILE:-${HOME:-}}"

HOME="$SMOKE_HOME" USERPROFILE="$SMOKE_HOME" MCODE_SMOKE_REAL_HOME="$REAL_HOME_BEFORE" \
  node "$OUT/smoke.mjs"
