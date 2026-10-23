#!/usr/bin/env bash
# Headless smoke for **MC-002 崩溃 → 重启 → 从零发现失败部署 → 续跑**(真跨进程)。
#
# 三个真 node 进程、同一个临时数据根:
#   ① `crash`            —— 真跑 applyScene,中途失败 → 盘上留 partial(带 specSnapshot),立即退出;
#   ② `discover-resume`  —— 入参只有模式名:从盘上跨场景列出 resumable 记录 → 取快照 →
#                           无授权续跑必须被拒 → 重新签发授权 → 续跑,只跑剩下的步;
#   ③ `verify`           —— 全新进程再读盘:最终 active + 验收 + handler 派发次数。
#
# 安全前提(与 scene-apply-smoke 同一条,不放松):数据根必须是 run.sh 里 mktemp 出来的
# 临时目录 —— `initDb()` 在路径不存在时会新建空库,**指错地方等于毁用户数据**。
# 数据根换来的是 `$MCODE_SMOKE_DATA_ROOT`(桩里没设就抛,见 run-store-smoke/stubs/dataRoot.ts)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-scene-crash-resume.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-scene-crash-resume-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

# 被测链 import electron(tools.ts 那条)与真实 logger / dataRoot;照 scene-apply-smoke
# 的取舍整套换桩。
"$ESBUILD" scripts/scene-crash-resume-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/window.js=./scripts/app-control-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

# ① 崩溃前:真部署到一半,自检结论落盘后 **SIGKILL 自己**(真死在中途,不走正常收尾)。
#    因此非零退出是**预期的**;它若其实没死(kill 未生效)会写 CRASH_SURVIVED —— 那才是失败。
#    A 自己的断言结论全在 crash-result.json 里,由 ② 读回复核(这里不吞任何失败)。
set +e
node "$OUT/smoke.mjs" crash
CRASH_CODE=$?
set -e
if [[ -e "$DATA/CRASH_SURVIVED" ]]; then
  echo "crash 进程没有被真的杀死(kill 未生效)" >&2
  exit 1
fi
if [[ $CRASH_CODE -eq 0 ]]; then
  echo "crash 进程正常退出了(预期是被 SIGKILL 杀掉)" >&2
  exit 1
fi
# ② 全新进程:从零发现 → 拒无授权 → 重新授权 → 只跑剩余步。
node "$OUT/smoke.mjs" discover-resume
# ③ 又一个全新进程:独立复读最终状态。
node "$OUT/smoke.mjs" verify
