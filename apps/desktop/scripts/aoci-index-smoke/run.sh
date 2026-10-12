#!/usr/bin/env bash
# aoci-index-smoke — 【MC-009】AOCI 代码索引(aoci.code.txt)与磁盘源码的一致性检查。
# 纯 Node 文本校验,不打包、不起 Electron:核对目录段根、对象条目、code: 关系引用。
# 索引只读;可用 MCODE_AOCI_CODE=<副本> 指向临时副本做变异验证。
set -euo pipefail
exec node "$(dirname "$0")/main.mjs"
