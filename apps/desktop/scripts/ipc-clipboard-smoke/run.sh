#!/usr/bin/env bash
# 剪贴板 IPC 错误文案回归(只由本套件维护)。
# 真调 `ipc/files.ts` 的 clipboard:* handler,真造一次 mkdir EEXIST,不起 Electron、
# 不联网、不碰用户真实临时目录(run.cjs 里受控 temp 根,退出即删)。
set -euo pipefail
node "$(dirname "$0")/run.cjs"
