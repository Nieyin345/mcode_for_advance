#!/usr/bin/env bash
# MAINT-2026-09 / M07 的独占套件(只由 M07 这个对话维护)。
# 与 path-guard-smoke 的分工:那一套只测 `lib/pathGuard.ts` 这个**共享**实现;
# 这一套测 `ipc/files.ts` 的**处理器实际用的是哪一份判定** —— 它自己另有一份
# 私有的 pathWithin,两份对大小写的处理不一致时,越界判定会在同一次调用里自相矛盾。
# 真建临时目录、真调 file:* 处理器,不起 Electron、不联网、不碰真实项目。
set -euo pipefail
node "$(dirname "$0")/run.cjs"

