#!/usr/bin/env bash
# subagent-lists-smoke —— 真浏览器核对:原生子代理归「任务列表」页,不归对话列表。
# 见 main.mjs 文件头。需要本机有 Chrome/Edge(与 settings-layout-smoke 同款,
# 由 run-smokes.mjs 的 isBrowserSuite 识别为重型套件单独限流)。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/subagent-lists-smoke/main.mjs
