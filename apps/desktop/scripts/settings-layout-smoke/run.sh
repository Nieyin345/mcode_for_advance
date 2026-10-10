#!/usr/bin/env bash
# settings-layout-smoke —— 把**真的 App** 挂进真 Chrome,量「打开设置不许动工作区布局」。
# 见 main.mjs 文件头。需要本机有 Chrome/Edge;无浏览器时本套件在 run-smokes.mjs 里
# 由 isBrowserSuite 识别为重型套件(单独限流)。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/settings-layout-smoke/main.mjs
