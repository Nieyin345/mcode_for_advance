#!/usr/bin/env bash
# memory-handoff-atomic-smoke —— 【MC-025】记忆助手交接三键(job/源索引/目标指针)
# 必须原子发表:崩溃在中途不许留下半边状态。
#
# **跑九趟,其中三趟故意把自己崩掉**(与 run-store-smoke / workflow-seed-smoke 同款
# 多趟模式;崩溃由 stubs/repositories.ts 在写点前 `flushDb()` + `process.exit(9)`)。
# 跨进程是这一条的题面:半边状态只在"下一次启动时"才会被用户看见。
#
#   1. seed            建库备料 + 无崩溃的撤回协议
#   2. crash-create    武装「源索引写点」→ 创建任务时崩溃(旧代码:job 已落盘、索引没写)
#   3. crash-queue     武装「目标指针写点」→ 转交时崩溃(旧代码:queued 已落盘、指针没写)
#   4. verify-restart  新进程读盘:不许有不可见 job、不许有半个指针;重试正控;两目标并发
#   5. crash-consume   武装「指针清理写点」→ 消费回执时崩溃(旧代码:consumed 已落盘、指针还在)
#   6. verify-consume  新进程:指针不许悬挂在终结态;中断的消费可重试;重复消费幂等
#   7. guard           同进程:写入中途失败(抛错,非崩溃)→ 两键皆旧可重试;并发交接
#                      状态互斥;收件箱淘汰不许吞掉排队包;坏存档 fail-closed 不覆盖
#   8. crash-expire    武装「指针清理写点」→ 过期迁移时崩溃(旧代码:只单键写 job,
#                      这个写点根本走不到 —— 崩溃趟会报"故障注入没触发";修复后同一
#                      事务被整体杀死)
#   9. verify-expire   新进程:中断的过期迁移保持旧状态可重试,重试后整体可见
#
# ⚠️ 2..6 各趟**必须**单独 `node` 起进程 —— 崩掉的趟本来就活不过它自己;
#    `set -e` 会被 exit(9) 终止脚本,所以崩溃趟用 `|| true`(下一趟的断言就是判据:
#    崩溃趟自己的"故障注入没触发"守卫和 verify 趟的不变式会给出红绿)。
#
# ⚠️ 数据根指向 `mktemp -d`(桩里没设就抛):这一套会建库、写 settings 行,而
#    `SettingRepo.set` 内部就是整库重写 —— 指错地方等于拿空库盖掉用户的聊天记录。跑完即删。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-memory-handoff.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-memory-handoff-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [ -z "$ESBUILD" ]; then ESBUILD="npx esbuild"; fi

# 三个 `--alias`:
#  - `@main/store/repositories.js` → 本套件的故障注入桩(export * 真模块,只在写点前拦截);
#  - dataRoot / logger:老两样(理由见 run-store-smoke/stubs 的文件头);
#  - electron:db.ts 顶层 import 了它(只出现在注释里,但仍给一个**真实存在**的桩,
#    不用"alias 目标不存在也能跑"这种未定义行为兜底)。
"$ESBUILD" scripts/memory-handoff-atomic-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/store/repositories.js=./scripts/memory-handoff-atomic-smoke/stubs/repositories.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

# 1) 备料(普通趟,失败即终止)。
node "$OUT/smoke.mjs" seed
# 2..3) 两趟崩溃:进程 exit(9) 是**预期**的,`|| true` 放行;下一趟读盘才是判据。
node "$OUT/smoke.mjs" crash-create || true
node "$OUT/smoke.mjs" crash-queue || true
# 4) 新进程读盘:半边状态在这里现形。
node "$OUT/smoke.mjs" verify-restart
# 5) 再崩一趟,这次打在消费回执的写点上。
node "$OUT/smoke.mjs" crash-consume || true
# 6) 又一条新进程。
node "$OUT/smoke.mjs" verify-consume
# 7) 同进程守卫:写入中途失败(非崩溃,抛错)两键皆旧、并发交接状态互斥、
#    淘汰窗口外的排队包不被吞、坏存档 fail-closed 且原字节不被覆盖。
node "$OUT/smoke.mjs" guard
# 8) 【MC-025 补漏】过期也是发表点:再崩一趟,这次打在过期迁移的指针清理写点上。
node "$OUT/smoke.mjs" crash-expire || true
# 9) 再一条新进程:中断的过期迁移必须保持旧状态可重试,重试后整体可见。
node "$OUT/smoke.mjs" verify-expire
