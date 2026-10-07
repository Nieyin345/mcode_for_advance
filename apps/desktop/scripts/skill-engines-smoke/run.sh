#!/usr/bin/env bash
# Headless smoke for 通用 skill 层的 per-engine 矩阵(main/lib/skillEngines.ts).
#
# skillEngines 是纯核心(不 import electron,路径全靠参数/临时目录注入),所以可以
# 直接 bundle:覆盖 missing=enabled 默认语义、最小化持久化(只存 false 键/全开删
# 条目)、坏文件防御、frontmatter 名字解析、skillNamesInRoot 扫描与
# enabledSkillNames/Dirs 的矩阵过滤。没有覆盖的:SKILLS_ENGINES_SET IPC handler
# (依赖 electron)和三引擎 provider 的消费点(要活的会话),靠真机验收。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-skill-engines-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/skill-engines-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
