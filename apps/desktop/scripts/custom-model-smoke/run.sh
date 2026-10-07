#!/usr/bin/env bash
# Headless smoke for `main/ipc/customModel.ts`(自定义模型端点那五条通道 + 扩展桥两条)。
#
# ## 两条隔离,缺一不可
#
# 1. **数据根**换成 `mktemp -d`(见 stubs/... 那句"没设就抛")。配置是**存库**的,
#    指错地方等于拿空库盖掉用户的自定义模型配置。
# 2. **用户根(`HOME` / `USERPROFILE`)也换成临时目录** —— 这一条是踩出来的:
#    连接探测会**真的启动 claude 二进制**,而它启动时读用户级配置和登录态。用户根不隔离,
#    这一套就会拿用户本机的凭据去**打真上游**(花钱,而且结果取决于网络和额度)。
#    ⚠️ 所以指向的目录里要**同时**有 `.claude.json` 和 `.claude/`(见下面),否则二进制
#    会走"首次运行"那条路,而那条路上它可能写字、也可能卡住。
#
# ## `--alias` 一份份换来由
#
# 换栈(不是被验代码的一份)清单:
#   - `@main/lib/dataRoot.js`  → 数据根桩(没设环境变量就抛)
#   - `@main/lib/logger.js`    → 日志桩(真那份 import electron)
#   - `@main/lib/secretStore.js` → 密钥库桩(真那份 import safeStorage)
#   - `electron`               → 整个包换掉(secretStore / db / sdkBinaryPath 那条链上
#                                还有几处会碰 electron,顺着 alias 一个个堵会变成打地鼠)
#   - `@anthropic-ai/claude-agent-sdk` → SDK 桩(不然会真的起子进程打上游)
#
# ⚠️ 最后那条**必须是包名**才换得掉:被测代码里写的就是
# `await import("@anthropic-ai/claude-agent-sdk")`。相对 import 换不掉(见技能文档)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-custom-model-smoke.XXXXXX)
HOME_DIR=$(mktemp -d /tmp/mcode-custom-model-home.XXXXXX)
trap 'rm -rf "$OUT" "$HOME_DIR"' EXIT

# 二进制启动时会读用户级配置。给它两个"空但存在"的:
#   `.claude.json` —— 它问"读过 onboarding 没有",没有就走首次运行那条路
#   `.claude/`     —— 配置目录本身
printf '{"hasCompletedOnboarding":true}' > "$HOME_DIR/.claude.json"
mkdir -p "$HOME_DIR/.claude"
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner` 那一行非有不可:sql.js 的 asm 构建里有 `require("node:fs")`,定死的 ESM
# 输出没有 `require`,esbuild 会把它换成一句抛错。这一套经 `secretStore` 桩绕开了
# `db.ts`(所以其实不加载 sql.js),但这一行留着 —— 哪天桩的范围一变,少它就是当场崩。
"$ESBUILD" scripts/custom-model-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/custom-model-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/secretStore.js=./scripts/custom-model-smoke/stubs/secretStore.ts \
  --alias:@anthropic-ai/claude-agent-sdk=./scripts/custom-model-smoke/stubs/sdk.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_HOME="$HOME_DIR"
# 数据根就落在隔离的用户根里:两种隔离用同一个临时目录,少一个变量少一处指错的机会。
export MCODE_SMOKE_DATA_ROOT="$HOME_DIR/data"
# 桩 SDK 把"真实收到的 options"写这里,断言据此核对探测走的是哪条链。
export MCODE_SMOKE_PROBE_LOG="$HOME_DIR/probe-options.jsonl"

node "$OUT/smoke.mjs"
