#!/usr/bin/env bash
# 【O6】五个编辑器换壳的「一起看」判据：五个 mcode-theme.css 的 :root 覆盖集必须相同。
# 只读文件，不启 Electron —— 「token 真的生效」是五套各自的工作。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
node "$HERE/main.mjs"
