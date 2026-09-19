#!/usr/bin/env bash
# Headless smoke for **「装/卸运行时和文档工具链」这条 IPC 路**:
#   - `src/main/ipc/runtimes.ts`(59 行,零覆盖)
#   - `src/main/ipc/toolchain.ts`(42 行,零覆盖)
#
# 走 `fakeIpc` 模式(抄 library-trash-smoke §4):造一个记名的 `ipcMain`,把
# **真的** `registerXxxHandlers` 注册进去,再按 channel 把注册进来的那个函数取回来调。
# 每个通道都真的走一遍 —— 不是复述 handler 的写法。
#
# ## 安装器全部换桩:这一趟**不下载、不安装、不动用户环境**
#
#   - **runtimes**:`installRuntime` / `installRuntimeFromLocalPath` 一次都不调
#     (会真的去 registry 拿几百 MB 的 tarball)。只走 `removeRuntime` 那条路,
#     它只 `rmSync(<root>/<agent>)`。
#   - **toolInstall 整包换桩**(`--alias:@main/env/toolInstall.js=…`):真的那个
#     会下 40 MB 的 pandoc / 165 MB 的 TinyTeX,`python-deps` 那一条更是
#     `pip install` **进用户自己的解释器**。而且这个文件**此刻有别的代理在改** ——
#     换桩让本套只钉 `ipc/toolchain.ts` 自己的职责,不被邻居的改动带红。
#   - **`checkToolchain` 不换桩**:纯探测(where.exe / python -c,只读),
#     而且「不带参数 invoke 也不许抛」这条判据要的就是真那条路。
#
# ## ⚠️ 三个根都必须指到 `mktemp -d`(安全前提,不是洁癖)
#
#   - **RUNTIMES**(`MCODE_SMOKE_RUNTIME_ROOT` → `setManagedRuntimeRoot()`):
#     `removeRuntime` 会递归删 `<root>/<agent>/`。真模块在无头脚本下 root 本来是
#     null,那时 `runtimeInstaller` 落到 `app.getPath("userData")` —— 指错就是把用户
#     花几百 MB 下下来的内核删掉。main.ts 里**先断言 setManagedRuntimeRoot 生效了**
#     再往下走,设不上直接 exit 1(同 archiver-installer-smoke 的姿态)。
#   - **TOOLS_ROOT**(`MCODE_SMOKE_TOOL_ROOT` → `setToolRoot()`):同理,
#     `removeTool` 会递归删 `<root>/<tool>/`。
#   - **DATA**(`MCODE_SMOKE_DATA_ROOT`):桩 `stubs/dataRoot.ts` 里**没设就抛**,
#     绝不回落到真库 —— sql.js 的 persist 是重写整个 `mcode.db`。
#
# ## 别名:为什么连 `electron` 整包一起换
#
# 两个被测文件都不直接用 electron,但 import 图里有:
#   - `runtimes.ts` → `runtimeInstaller.ts` 顶层 `import { app } from "electron"`
#     (`loadExpectedVersions()` 读 app.getAppPath());
#   - `toolchain.ts` → `env/agentEnv.ts` → `env/managedToolRoots.ts`。
# 顺着别名一个个堵会变成打地鼠,而每漏一个报出来的都是「找不到模块 electron」,
# 看着和"被测代码坏了"一样(同 library-delete-smoke 的取舍)。
#
# ⚠️ `--alias:` **只认包名,换不掉相对 import**。这里换的都是 `@main/...` 或包名,
# 所以不会踩那条"两份模块实例"的坑:桩与脚本指的是**同一个文件**。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-installers-ipc.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-installers-ipc-data.XXXXXX)
RUNTIMES=$(mktemp -d /tmp/mcode-installers-ipc-runtimes.XXXXXX)
TOOLS=$(mktemp -d /tmp/mcode-installers-ipc-tools.XXXXXX)
trap 'rm -rf "$OUT" "$DATA" "$RUNTIMES" "$TOOLS"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")`,而定死的
# ESM 输出没有 `require`(同 run-store-smoke/run.sh 同一段理由)。
"$ESBUILD" scripts/installers-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/installers-ipc-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/installers-ipc-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/installers-ipc-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/installers-ipc-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/installers-ipc-smoke/stubs/runtimeManager.ts \
  --alias:@main/env/toolInstall.js=./scripts/installers-ipc-smoke/stubs/toolInstall.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
export MCODE_SMOKE_RUNTIME_ROOT="$RUNTIMES"
export MCODE_SMOKE_TOOL_ROOT="$TOOLS"

node "$OUT/smoke.mjs"
