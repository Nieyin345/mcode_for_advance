#!/usr/bin/env bash
# repo-lockfile-smoke —— 【MC-038】根仓库只许有一份权威 lockfile(pnpm)。
#
# 只读套件:**不需要桩、不碰数据根** —— 它只问 git(版本控制里有哪些锁文件、
# gitignore 挡没挡住)与读两个文本文件(package.json / 两个 workflow)。
# 不建任何目录、不写任何文件。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-repo-lockfile.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
if [ -z "$ESBUILD" ]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/repo-lockfile-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
