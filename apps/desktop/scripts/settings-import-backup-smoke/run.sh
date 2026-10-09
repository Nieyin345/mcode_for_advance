#!/usr/bin/env bash
# settings-import-backup-smoke —— 「导入设置前先备份」这条承诺的回归网(见 main.ts 文件头)。
#
# ## 换桩的边界
#
#   - `electron` —— `stubs/electron.ts`,**能喂** userData 根与打开框返回值(本套要让
#     备份写不成,而写不成的办法就是把 `<userData>/settings-backups` 占成同名文件 ——
#     于是"userData 指向哪"必须由脚本说了算)。
#   - `@main/window.js` / `@main/mobile/MobileEventBus.js` —— 复用 projects-ipc-smoke 的
#     两份桩(导入会经 `broadcastSettingChangedToAll` 广播,那条要窗口与手机总线)。
#   - `@main/notifications/NotificationManager.js` —— 本套的桩(真那个顶层拽着 electron
#     的 Notification 与三个引擎的 SDK;导入只用到它的 `reloadPrefs`)。
#   - `@main/lib/dataRoot.js` / `@main/lib/logger.js` —— 复用 run-store-smoke 的两份桩。
#   - `@main/store/repositories.js` 用**真的** —— 设置要真写进库、真读回来。
#
# ⚠️ **数据根必须是 `mktemp -d`。** 这一套真建库、真写设置行(内部都是 `persist()`,
# `sql.js` 的 `db.export()` **重写整个 mcode.db**)。指到用户真数据根等于毁数据。
# (userData 那个根由 main.ts 自己 `mkdtemp` 出来再喂进 electron 桩的 `setUserData()` ——
#  备份就写在它下面。)`stubs/dataRoot.ts` 那句"没设环境变量就抛"就是为这件事 —— 别去改它。
#
# ⚠️ `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")`,而定死的
# ESM 输出**没有 `require`** —— esbuild 会把它换成一句 `throw new Error(...)`。
#
# ⚠️ `--alias:` **只认包名**,相对路径的 import 换不掉。这里一条 `--external` 都不用。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-settings-import-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-settings-import-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/settings-import-backup-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/settings-import-backup-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/projects-ipc-smoke/stubs/window.ts \
  --alias:@main/mobile/MobileEventBus.js=./scripts/projects-ipc-smoke/stubs/mobileEventBus.ts \
  --alias:@main/notifications/NotificationManager.js=./scripts/settings-import-backup-smoke/stubs/notificationManager.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
