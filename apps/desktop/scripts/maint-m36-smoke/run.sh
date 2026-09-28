#!/usr/bin/env bash
# MAINT M36:契约 → preload → 主进程三层的静态对账补充(不起 Electron、不装依赖)。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/maint-m36-smoke/main.mjs
