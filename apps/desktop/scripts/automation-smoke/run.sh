#!/usr/bin/env bash
# Headless smoke for 自动化的两个新节点(触发器 + 决策节点),外加**执行器本体**
# (`automationRunner.ts`)的两条回归网:定时去重的跨重启记忆、删掉的文件不进载荷。
#
# 调度器那一半(scheduler-smoke 的写法):esbuild 打包 + 假 RunPorts,纯 node 跑。
# 会话那一半要真库:脚下那个数据根换成临时目录 —— 复用 run-store-smoke 的两个 stub
# (`dataRoot` 没设环境变量就抛,`logger` 静音),跑完连目录一起删,不碰用户真正的数据。
#
# ⚠️ 第 13 节会**真的 `new` 一个 `AutomationRunner`** 并调它的 `start()` —— 那会往
# settings 表写 `automation.lastMinute`(`SettingRepo.set` 内部是 `persist()`,**重写
# 整个 `mcode.db`**)。所以 `MCODE_SMOKE_DATA_ROOT` 指向真库等于毁数据。临时目录这一条
# 不是洁癖,是这套脚本能跑的前提。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-automation-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-automation-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

# ── 先打那份**外置的桩**(`@main/orchestration/runner.js` 的替身)──────────────
#
# `automationRunner` 里那句 import 是**相对**的(`from "./runner.js"`),而 esbuild 的
# `--alias:` 只认包名 —— 给它一个相对路径会直接报 `Invalid alias name: "./runner.js"`。
# 所以把它整条**外置**:主 bundle 里原样留着 `import … from "./runner.js"`,再把这个桩
# 单独打成一个同名模块放在它旁边,运行时由 node 自己接上。
#
# 分两层是**为了让脚本与主 bundle 看见同一份桩**:主 bundle 要的是 `./runner.js`,
# 而脚本自己 import 的是 `./stubs/runner.js`(它写的是脚本视角的路径)。两层转发之后
# 两边的 `runs` 是**同一个数组** —— 不这么绕的话,脚本记的那份和被测代码调的那份是
# 两份状态,断言永远看不到东西。
#
# **真 `runner.ts` 没被换掉**(它照旧参与 `tsc`、照旧是真代码);这里替的是它在**这一套
# 冒烟运行时**里的那一份,理由见 `stubs/runner.ts` 的文件头。
"$ESBUILD" scripts/automation-smoke/stubs/runner.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/stubs/runner.js" --log-level=error
printf 'export * from "./stubs/runner.js";\n' > "$OUT/runner.js"

# `--banner` 给 sql.js 的 asm 构建一个真的 require(见 run-store-smoke/run.sh 同一段)。
#
# 换桩的四个:`dataRoot` / `logger` 是每套都有的;`RuntimeManager` 那条链拉着
# `window.js`(要 electron 的 `BrowserWindow`)与三个引擎实现;`pluginManager` 同上
# (真那个会读插件目录)。`--external:./runner.js` 配上面那份外置桩用。
"$ESBUILD" scripts/automation-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:./runner.js \
  --external:./stubs/runner.js \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/automation-smoke/stubs/runtimeManager.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcode-admin-smoke/stubs/pluginManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
# Reopen the isolated DB in a fresh process to verify the persisted self-trigger budget.
node "$OUT/smoke.mjs" --verify-self-budget
