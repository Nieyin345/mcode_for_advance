#!/usr/bin/env bash
# Headless smoke for the Skills / MCP 「市场」 tabs (R67):
#  - lib/mcpMarket.ts:registry server.json → 安装方式换算、来源增删、搜索(/v0.1 → /v0 回退、
#    翻页、去重)—— fetch 换成假的,不联网;
#  - contracts buildMcpMarketConfig:必填校验、argv / env / headers 拼装;
#  - lib/skillMarket.ts:本地目录市场的添加 / 扫描 / 安装 / 同名跳过 / 移除;
#  - skillEngines.parseSkillFrontmatter 的 YAML 块标量(`description: >`)。
#
# ⚠️ HOME/USERPROFILE 必须重定向:安装会真往 `~/.mcode/skills` 写。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-market-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/market-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/store/repositories.js=./scripts/market-smoke/stubs/repositories.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

SMOKE_HOME="$OUT/home"
mkdir -p "$SMOKE_HOME"
HOME="$SMOKE_HOME" USERPROFILE="$SMOKE_HOME" node "$OUT/smoke.mjs"
