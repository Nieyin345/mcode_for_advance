#!/usr/bin/env bash
# git 丢弃/只读 handler 的独占套件。**真 git,真仓库** —— git.ts 的那几条形状
# (索引 A / AM / ?? / " M")只有真跑 git 才分得清。仓库是临时目录,跑完全删。
set -euo pipefail
node "$(dirname "$0")/run.cjs"
