#!/usr/bin/env bash
# Headless smoke for **自动更新**(`main/updater.ts`,370 行、零覆盖)。
#
# ## 六趟,六个进程(两条原因逼出来的)
#
#  1. `main.ts`     —— 主体:状态机 + 推给界面什么 + `update.state` 的落盘/清除。
#  2. `darwin.ts` ×4 —— macOS 的签名判断,由 `MCODE_SMOKE_CODESIGN` 摆四种 codesign
#     结果(adhoc / signed / missing / failed)。**必须单独进程**:那个结果被模块级
#     缓存(`manualInstallRequiredCache`),一个进程里只能定一次。
#  3. `noDb.ts`     —— 库里写不进去时更新流程不许炸。**必须单独进程**:它要的是
#     "`initDb()` 从来没跑过",而 `initDb()` 在一进程里是记忆化的、回不去。
#
# 分离的写法照 `archiver-installer-smoke`(它那份 `clean.ts` 是同一个理由)。
#
# ## 三条安全前提(这套脚本能跑的前提)
#
#  1. **数据根是 `mktemp -d` 出来的**(`MCODE_SMOKE_DATA_ROOT`),跑完就删。本套真的
#     建库、真的往 `settings` 表写 `update.state`(那正是要验的东西之一),而
#     **`sql.js` 的 persist 是重写整个 `mcode.db`** —— 指错地方就是拿空库盖掉用户的
#     聊天记录。共用的 `stubs/dataRoot.ts` **没设环境变量就抛**,不回落。
#  2. **不联网。** `electron-updater` 整个换成 bundle 旁边那份记账桩(见下),所以
#     `checkForUpdates()` 不会真去 GitHub 拉 `latest.yml`,也不用下几百 MB。
#  3. **不碰这台机器的 codesign。** `node:child_process` 换成桩(见
#     stubs/childProcess.ts);那段代码实测只在 macOS 上跑,桩让它在本机也能被摆出来。
#
# ## ⚠️ 别名里最关键的一条:`electron-updater` 是**运行期 require** 拿的
#
# `updater.ts` 拿它走的是 `createRequire(import.meta.url)("electron-updater")` ——
# 一句**运行期**的 require,esbuild 的 `--alias:` **管不到**(实测;同 terminal-smoke
# 里 `loadNodePty()` 那一句)。真那个无论如何也用不了:它在无头 node 里顶层
# `new NsisUpdater()` 就要 `electron.app`,`require` 出来直接抛。
#
# 所以改成:把桩当真包,摆到 **bundle 旁边的** `node_modules/electron-updater/`。
# `createRequire(import.meta.url)` 解析时先看 bundle 自己所在目录的 node_modules,
# 于是一路吃到桩。顺带一句好处:脚本与被测代码因此拿到的是**同一个**实例(CJS 按
# 解析后的文件名缓存),脚本 `fire()` 的事件一定落到被测模块挂的监听器上 —— 这正是
# mcode-smoke/SKILL.md 里那条"两份模块实例"的坑,这里靠"只有一个文件"绕开。
#
# ## 相对 import 那一类(换不掉、也不需要换)
#
# `updater.ts` 的相对 import(`./store/repositories.js`、`./lib/logger.js`……)全部
# 跟着 bundle 一起走。本套只把 `electron` 包、`window`、`dataRoot`、`logger`、
# `child_process` 这几条**要观测或要摆弄**的换掉。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-updater-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-updater-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")`,而定死的
# ESM 输出没有 `require`(同 run-store-smoke/run.sh 同一段理由)。
#
# ⚠️ `--alias:node:child_process` 能生效,是因为 `updater.ts` 那句是**静态**
# `import { spawnSync } from "node:child_process"` —— 与上面那条运行期的
# `require("electron-updater")` 恰好相反。两种在这个文件里同时存在。
COMMON=(
  --bundle --platform=node --format=esm
  --tsconfig=tsconfig.json
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  --alias:electron=./scripts/updater-smoke/stubs/electron.ts
  --alias:node:child_process=./scripts/updater-smoke/stubs/childProcess.ts
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts
  --alias:@main/window.js=./scripts/updater-smoke/stubs/window.ts
  --log-level=error
)

"$ESBUILD" scripts/updater-smoke/main.ts   "${COMMON[@]}" --outfile="$OUT/main.mjs"
"$ESBUILD" scripts/updater-smoke/darwin.ts "${COMMON[@]}" --outfile="$OUT/darwin.mjs"
"$ESBUILD" scripts/updater-smoke/noDb.ts   "${COMMON[@]}" --outfile="$OUT/noDb.mjs"

# ── bundle 旁边的 electron-updater:**替身包** ──
# 这是 `loadAutoUpdater()` 那句运行期 require 会命中的那一份。三份 bundle 都在
# `$OUT` 下,所以它们共用这一份 —— 而它们本来也是一个个独立进程,不共享状态。
mkdir -p "$OUT/node_modules/electron-updater"
cp scripts/updater-smoke/stubs/electron-updater/index.cjs "$OUT/node_modules/electron-updater/index.cjs"
cp scripts/updater-smoke/stubs/electron-updater/package.json "$OUT/node_modules/electron-updater/package.json"

export MCODE_SMOKE_DATA_ROOT="$DATA"

# 一趟失败不影响后面的继续跑(照 archiver-installer-smoke 的取向:每趟都要留下痕迹)。
failures=0
run() {
  echo
  echo "════════ $* ════════"
  if ! "$@"; then failures=$((failures + 1)); fi
}

run node "$OUT/main.mjs"
run env MCODE_SMOKE_CODESIGN=adhoc   node "$OUT/darwin.mjs"
run env MCODE_SMOKE_CODESIGN=signed  node "$OUT/darwin.mjs"
run env MCODE_SMOKE_CODESIGN=missing node "$OUT/darwin.mjs"
run env MCODE_SMOKE_CODESIGN=failed  node "$OUT/darwin.mjs"
run node "$OUT/noDb.mjs"

echo
if [[ "$failures" -gt 0 ]]; then
  echo "updater-smoke:$failures 趟有失败"
  exit 1
fi
