#!/usr/bin/env bash
# Headless smoke for lib/piModelsStore.ts —— 见 main.ts 文件头。
#
# ⚠️ HOME / USERPROFILE 必须指向临时目录:这一套真的会写 `~/.pi/agent/models.json`,
# 指错地方等于改用户真的 Pi 配置(main.ts 开头会校验,没指到就拒绝运行)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-pi-models-store-smoke.XXXXXX)
FAKE_HOME=$(mktemp -d /tmp/mcode-pi-models-home.XXXXXX)
trap 'rm -rf "$OUT" "$FAKE_HOME"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# 换桩的三个都是因为 electron:SettingRepo(数据库)、safeStorage、日志文件。
"$ESBUILD" scripts/pi-models-store-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/store/repositories.js=./scripts/pi-models-store-smoke/stubs/repositories.ts \
  --alias:@main/lib/secretStore.js=./scripts/pi-models-store-smoke/stubs/secretStore.ts \
  --alias:@main/lib/logger.js=./scripts/pi-models-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# Windows 上 os.homedir() 读 USERPROFILE,其余平台读 HOME —— 两个都指过去。
if command -v cygpath >/dev/null 2>&1; then FAKE_HOME_NATIVE=$(cygpath -w "$FAKE_HOME"); else FAKE_HOME_NATIVE="$FAKE_HOME"; fi
export HOME="$FAKE_HOME_NATIVE" USERPROFILE="$FAKE_HOME_NATIVE" MCODE_SMOKE_HOME="$FAKE_HOME_NATIVE"

node "$OUT/smoke.mjs"
