#!/usr/bin/env bash
# 【T20】扩展工坊回归 —— AI 写扩展的六步闭环。
#
# 本套跑在真 node 里：真子进程沙箱（runPermissionedProcess）、真临时目录、真
# ModuleHost（内存桩）。**不碰用户数据根**。
#
# ## 变异（build.mjs 内置两条，对应卡面验收 7）
#
#   1. `self-approve`：把交接材料的 `installConsent` 从 `allow-once` 改成
#      `allow-always`（「AI 不能自己批准」的机器表达）→ 对应断言必须变红；
#   2. `no-sandbox`：把 `buildExtension` 里沙箱冒烟的失败判定改成永远成功
#      （「沙箱失败不装机」的机器表达）→ 对应断言必须变红。
#
# 两条都用源码锚点替换注入；锚点缺失时 build.mjs 直接失败（不静默跳过）。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/extension-workshop-smoke/build.mjs
