#!/usr/bin/env bash
# 扩展专用数据区(报告 E12)的无头 smoke —— `@contracts/extensionStore` 的形状/校验/
# 配额,以及 `main/lib/extensionStore.ts` 的磁盘读写与 `main/ipc/extensions.ts` 的六条 handler。
#
# 桩:dataRoot(真那个 import electron)。`@main/lib/extensionStore.ts` 落盘走 appContext 的
# `atomicWrite`(纯 node:fs,不 import electron),但它现在**也**用 `@main/lib/osFileLease.js`
# 的宿主级目录租约(MC-096 总量竞态);这里**额外**把 `@main/lib/appContext.js` 换成一份转发壳
# (`stubs/appContextFault.ts`),好让「总量检查 → 落盘」这一步之间能**确定性地**塞进第二个写者
# —— 复现并发竞态(未设钩子时逐调用转发真实实现,生产代码一行未改)。
#
# 【MC-095】`main/ipc/extensions.ts` 现在引 `main/memory/agentScope.js`(可信扩展身份闸),
# 那里顶部 import 了 `SessionRepo` —— 不换桩会顺带把 `repositories → db → electron`
# 整条链收进 bundle。换掉 `repositories`(与 memory-smoke 同一份形状),本套不读会话。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-extension-store.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-extension-store-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/extension-store-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/extension-store-smoke/stubs/dataRoot.ts \
  --alias:@main/store/repositories.js=./scripts/extension-store-smoke/stubs/repositories.ts \
  --alias:@main/lib/appContext.js=./scripts/extension-store-smoke/stubs/appContextFault.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
