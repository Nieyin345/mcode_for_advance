#!/usr/bin/env bash
# Headless smoke for **手机网页壳一侧的跨端同步**(`renderer/lib/webApi.ts` +
# `renderer/stores/sessionStore.ts`)。
#
# 与 session-store-smoke 的区别:那一套把自己装成桌面(`mcodeElectron: true`、
# `window.api` 是桩),本套装成**手机**:没有 `window.api`,`lib/api.ts` 于是用真的
# `createWebApi()`;`fetch` 换成一个假的主进程(内存里的项目 / 会话 / 消息 / 设置表),
# 每一条 RPC 都记下来。于是能验:
#   - 设备本地键进 localStorage、不发 RPC;共享键照常走 RPC;
#   - `setting.changed` 当场套用(和 init 读库同一套解析 / 夹取);
#   - 快照 `desktopAttached` 决定手机写不写回合消息;
#   - `projects.changed` 的差异合并;
#   - 断线补齐:库为准的消息重拉、在跑的会话等 turn.done 之后再拉。
# 不起服务、不连网。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-mobile-sync-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/mobile-sync-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
