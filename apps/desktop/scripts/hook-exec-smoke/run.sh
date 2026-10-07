#!/usr/bin/env bash
# Headless smoke for 钩子「执行」那一半 —— 见 main.ts 文件头:路径主语(反斜杠那一条)、
# 真起进程(退出码/超时/编码)、hooks.json 的落盘与降级。
#
# 这一套**真的起子进程**(钩子命令是 `node 那个文件`),也**真的写 hooks.json** ——
# 只是把它脚下的数据根和临时目录都换成 `mktemp -d`,收尾时删掉。
#
# ⚠️ **dataRoot 必须指向临时目录。** 存放层真的会写 `hooks.json`,指错地方等于拿一份空
# 配置盖掉用户亲手写的钩子(见 stubs/dataRoot.ts 里那句"没设就抛")。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-hook-exec-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-hook-exec-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

# 换桩的两个,都是因为 import 了 electron(`app.getPath("userData")`):
#  - `dataRoot` —— 存放层的文件系统根;
#  - `logger`   —— 真的那个把日志写进数据根。
# 其余一个都不用换:这三个文件刻意不依赖主进程的任何东西(见 runCommand.ts 文件头)。
"$ESBUILD" scripts/hook-exec-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/hook-exec-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/hook-exec-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# 脚本自己也认这个变量(它指向自己的临时数据根);在这儿一并导出,是为了那一路在
# "没设就抛"的桩下也起得来。
export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
