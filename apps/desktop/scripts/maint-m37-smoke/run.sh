#!/usr/bin/env bash
# MAINT M37:共享词典对账(zh 为 MessageId 源;en 孤儿键 / 跨域重复键 / 占位符不一致)。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/maint-m37-smoke/build.mjs
