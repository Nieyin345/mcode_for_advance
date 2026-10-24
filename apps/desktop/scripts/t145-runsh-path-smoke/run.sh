#!/usr/bin/env bash
# 【T145】守卫：smoke 的 run.sh 在 `cd` 之后不许用 `dirname "$0"`。
#
# 纯静态检查 —— 读 611 个 run.sh 的文本，不起 node、不打包、不起浏览器。
# 判据的取舍见 build.mjs 文件头。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/t145-runsh-path-smoke/build.mjs
