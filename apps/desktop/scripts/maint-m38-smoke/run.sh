#!/usr/bin/env bash
# MAINT M38:SQL 里的 ESCAPE 子句必须是单字符 —— 用真 sql.js 把每一处都 prepare 一遍。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/maint-m38-smoke/build.mjs
