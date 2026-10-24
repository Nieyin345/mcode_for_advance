#!/usr/bin/env bash
# Headless smoke for **视觉中继的重那半** —— `main/lib/visionRelay.ts`（读设置、走既有 SDK
# 链路、发 query、兜失败）。零依赖的那半 `visionRelayCore.ts` 由 `vision-relay-smoke` 覆盖。
#
# ## 两条隔离，缺一不可
#
# 1. **数据根**换成 `mktemp -d`(见 stubs/dataRoot 那句"没设就抛")。中继设置是**存库**的,
#    指错地方等于拿空库盖掉用户的视觉中继配置。
# 2. **用户根(HOME/USERPROFILE)**也换成临时目录 —— 内置模型那条路不传 env,SDK 会继承
#    进程环境读用户级登录态。虽然本套的 SDK 是桩,但 guard 留着(哪天桩范围一变就靠它)。
#
# ## `--alias` 换栈清单（都不是被验代码）
#   - `@main/lib/dataRoot.js`            → 数据根桩(没设环境变量就抛)
#   - `@main/lib/logger.js`              → 日志桩(真那份 import electron)
#   - `@main/store/repositories.js`      → 内存 SettingRepo(sql.js 会毁真库)
#   - `@main/ipc/git.js`                 → resolveModelForGitOp 桩(真那份拉 electron/simple-git)
#   - `@anthropic-ai/claude-agent-sdk`   → SDK 桩(包名,否则真的 spawn 二进制打上游)
#
# ⚠️ 最后那条**必须是包名**才换得掉:被测代码里写的是 `await import("@anthropic-ai/claude-agent-sdk")`。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-vision-relay-heavy.XXXXXX)
HOME_DIR=$(mktemp -d /tmp/mcode-vision-relay-heavy-home.XXXXXX)
trap 'rm -rf "$OUT" "$HOME_DIR"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/vision-relay-heavy-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/store/repositories.js=./scripts/vision-relay-heavy-smoke/stubs/repositories.ts \
  --alias:@main/ipc/git.js=./scripts/vision-relay-heavy-smoke/stubs/git.ts \
  --alias:@main/providers/claude-sdk/customEnv.js=./scripts/vision-relay-heavy-smoke/stubs/customEnv.ts \
  --alias:@main/providers/claude-sdk/sdkBinaryPath.js=./scripts/vision-relay-heavy-smoke/stubs/sdkBinaryPath.ts \
  --alias:@anthropic-ai/claude-agent-sdk=./scripts/vision-relay-heavy-smoke/stubs/sdk.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$HOME_DIR/data"
HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" node "$OUT/smoke.mjs"
