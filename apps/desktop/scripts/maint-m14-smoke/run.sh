#!/usr/bin/env bash
# MAINT-M14 定向 smoke —— MCP 工具与会话端点。见 main.ts 的文件头:钉哪三块、
# 为什么既有的三套(mcp-endpoint / mcp-engines / mcp-ipc)不覆盖它们。
#
# ## 换了哪些桩,以及为什么
#
#   @main/store/db.js            —— 真那份要 sql.js + 真数据根。本套验的是
#                                   `mcpConfig` 拿到一行坏数据时的行为,和库无关。
#   @main/store/repositories.js  —— 内存版 SettingRepo,额外开 seedRaw/peekRaw,
#                                   好把"不是合法 JSON 的一行"塞进去。
#   @main/lib/logger.js          —— 真那份经 app.getPath 拉 electron。
#   @main/lib/codexModelsStore.js—— materializeAllMcpViews 里那句 await import()
#                                   会被 esbuild 静态打进来,而真那份要 electron。
#
# ⚠️ **`@main/providers/claude-sdk/customEnv.js` 故意不换桩。** 它就是一句
# `path.join(homedir(), ".mcode")` 且**模块级求值** —— 把 HOME/USERPROFILE 指到
# 临时目录,`.claude.json` / `mcp-engines.json` 就整体搬进临时目录了。换桩反而会
# 出现"同一个文件两个说明符 → 两份实例"(mcp-ipc-smoke 的 run.sh 记了那条岔路)。
#
# 本套只碰:临时目录里的假 HOME、`$TMPDIR` 下自己建的进程/搜索夹具。
# 不起服务器、不占端口、不发网络请求、不碰用户真实的 ~/.mcode 与数据根。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-maint-m14-smoke.XXXXXX)
fake_home=$(mktemp -d /tmp/mcode-maint-m14-home.XXXXXX)
mkdir -p "$fake_home/.mcode"
# 真相层迁移的来源:`~/.mcode/.claude.json` 的 mcpServers。main.ts 的 A4 断言
# 这一条被抬进 userServers —— 也就是"坏行之后确实走完了迁移",不是空转。
cat > "$fake_home/.mcode/.claude.json" <<'JSON'
{
  "mcpServers": {
    "seeded-remote": { "type": "http", "url": "https://example.invalid/mcp" }
  },
  "someUnrelatedCliKey": 1
}
JSON
trap 'rm -rf "$OUT" "$fake_home"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/maint-m14-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/store/db.js=./scripts/maint-m14-smoke/stubs/db.ts \
  --alias:@main/store/repositories.js=./scripts/maint-m14-smoke/stubs/repositories.ts \
  --alias:@main/lib/logger.js=./scripts/maint-m14-smoke/stubs/logger.ts \
  --alias:@main/lib/codexModelsStore.js=./scripts/maint-m14-smoke/stubs/codexModelsStore.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

HOME="$fake_home" USERPROFILE="$fake_home" node "$OUT/smoke.mjs"

