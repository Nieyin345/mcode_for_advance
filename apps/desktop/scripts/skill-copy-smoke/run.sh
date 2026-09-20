#!/usr/bin/env bash
# Headless smoke for 「技能复制到项目」(skills.copyToProject).
#
# 这是全仓库唯一一处 Mcode 往**用户项目目录**写文件的地方(<项目>/.claude/skills/)。
# 覆盖:落点正确(<项目>/.claude/skills/<名字>/)、整目录带附属文件、**同名不覆盖**
# (不可逆的那一侧)、三种下场(copied/skipped/failed)分别回报、相对路径被拒。
#
# ⚠️ **HOME/USERPROFILE 必须重定向。** `defaultSkillsRoot()` 拼的是
# `homedir()/.mcode/skills`,而这套脚本会**真往盘上写** —— 指到真家目录就是拿测试
# 数据往用户的技能库里灌。Node 的 `os.homedir()` 在 POSIX 上认 HOME、在 win32 上
# 认 USERPROFILE,两个都要设(同 plugins-smoke 的做法)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-skill-copy-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/skill-copy-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/skill-copy-smoke/stubs/pluginManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

SMOKE_HOME="$OUT/home"
mkdir -p "$SMOKE_HOME"
HOME="$SMOKE_HOME" USERPROFILE="$SMOKE_HOME" node "$OUT/smoke.mjs"
