#!/usr/bin/env bash
# 【Office 深度集成】六编辑器在宿主里的 AI 归属判据 —— 只读源码，不启 Electron。
# 「token / 面板真的生效」是各家 o6-reshell-*-smoke 的工作，两者不互相替代。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
node "$HERE/main.mjs"
