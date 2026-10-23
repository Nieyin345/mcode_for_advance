#!/usr/bin/env bash
set -euo pipefail
# 只读产物与源码,不启 Electron、不写仓库。产物由 T25 的重建流程生成。
node "$(dirname "$0")/main.mjs"
