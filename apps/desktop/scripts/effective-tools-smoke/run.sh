#!/usr/bin/env bash
# Headless smoke for the EffectiveToolInventory diagnostic (MC-100 / MC-101).
#
# 它是**只读诊断**:不调任何 SDK、不起 Electron、不碰 ~/.mcode。它调各 provider 现成的
# 描述符构造函数(libraryToolDescriptors / workflowEngineBridge.descriptors / Codex
# buildDynamicTools …)拿真实工具表,只做统计。
#
# 别名分两类(理由与 mcode-admin-smoke / mcp-endpoint-smoke 同):
#   - electron / window / theme / secretStore / dataRoot / logger —— 真那份 import
#     electron(无头给不出来);一律显式抛或在无头下 no-op,不静默;
#   - broadcast / RuntimeManager / pluginManager —— 库与工作流工具表会顺着 import 图
#     拖进来;本套不验广播与装配,换掉即可。
#
# 产物落在 `apps/desktop/.tmp/`(不是 /tmp):`@anthropic-ai/claude-agent-sdk` 保持
# external,裸包名按产物位置往上找 node_modules。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d ./.tmp/effective-tools-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-effective-tools-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/effective-tools-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:ssh2 \
  --external:@anthropic-ai/claude-agent-sdk \
  --alias:electron=./scripts/agent-mail-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/agent-mail-smoke/stubs/window.ts \
  --alias:@main/lib/theme.js=./scripts/library-mcp-smoke/stubs/theme.ts \
  --alias:@main/lib/secretStore.js=./scripts/library-mcp-smoke/stubs/secretStore.ts \
  --alias:@main/lib/logger.js=./scripts/mcode-admin-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcode-admin-smoke/stubs/pluginManager.ts \
  --alias:@main/orchestration/broadcast.js=./scripts/mcode-admin-smoke/stubs/broadcast.ts \
  --alias:@main/memory/broadcast.js=./scripts/mcp-endpoint-smoke/stubs/memoryBroadcast.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
