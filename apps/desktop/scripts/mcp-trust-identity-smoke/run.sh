#!/usr/bin/env bash
# Headless smoke for 【MC-055】: 项目 MCP 授信身份不可伪造。
#
# 真建 A/B 临时目录、真写 git 布局,调真实 projectIdentity / projectServerFingerprint
# / getTrustedProjectMcpServers。持久化用内存桩(SettingRepo → Map),db/logger 桩掉以避开
# electron 与 sql.js,绝不碰真库(sql.js 的 db.export() 会重写整个 mcode.db)。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-mcp-trust.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/mcp-trust-identity-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/store/repositories.js=./scripts/mcp-trust-identity-smoke/stubs/repositories.ts \
  --alias:@main/store/db.js=./scripts/mcp-trust-identity-smoke/stubs/db.ts \
  --alias:@main/lib/logger.js=./scripts/mcp-trust-identity-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
