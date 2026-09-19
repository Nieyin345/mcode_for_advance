#!/usr/bin/env bash
# Headless smoke for `main/ipc/usage.ts` + `main/ipc/outputStyle.ts`
# (设置面板「用量统计」与「输出风格」两条只读聚合通道)。
#
# ## 两条隔离,缺一不可
#
# 1. **数据根**换成 `mktemp -d`(见 stubs/dataRoot.ts 那句"没设就抛")。这一套会
#    `initDb()` 并真的建库写行,而 `sql.js` 的 `db.export()` **重写整个 `mcode.db`**
#    —— 指错地方等于拿空库盖掉用户的聊天记录。
# 2. **用户根(`HOME` / `USERPROFILE`)也换成临时目录** —— 这一条是踩出来的:
#    `outputStyleConfig.ts` 的 `USER_STYLE_DIR` 是在**模块求值时**用 `homedir()`
#    算出来的(`homedir()` 在 POSIX 读 `$HOME`、在 Windows 读 `USERPROFILE`),
#    而这一套会**往那个目录写 `.md` 夹具**。用户根不隔离,跑一次就往用户的
#    `~/.mcode/output-styles` 里扔进六个文件。
#
# ## `--alias` 一份份换来由
#
#   - `electron`               → 整个包换掉。`outputStyle.ts` 经 `outputStyleConfig.js`
#                                → `@main/store/db.js` 拖进 sql.js;`usage.ts` 经
#                                `usageStats.js` → `secretStore.js` 拖进 `safeStorage`。
#                                顺着 alias 一个个堵会变成打地鼠,每漏一个报出来的都是
#                                "找不到模块 electron",看着和"被测代码坏了"一模一样。
#   - `@main/lib/dataRoot.js`  → 数据根桩(没设环境变量就抛)
#   - `@main/lib/logger.js`    → 日志桩(真那份 import electron)
#
# ⚠️ **刻意不给 `@main/lib/usageStats.js` / `@main/lib/outputStyleConfig.js` 配桩。**
# 那两个就是被测行为本身;而且 `usageStats.ts` 内部那句 `SessionRepo.listUsageRows()`
# 是**相对 import**(`../store/repositories.js`),`--alias:` 换不掉它 —— 换了桩反而会
# 得到两套状态,断言看的就不是被测代码(见技能文档里那段)。
#
# ## `--banner` 那一行非有不可
#
# sql.js 的 asm 构建里有 `require("node:fs")` / `require("node:crypto")`,而定死的 ESM
# 输出**没有 `require`** —— esbuild 会把它换成一句抛错。给它一个真的 `require`
# (从 `node:module` 的 `createRequire` 来),它就能跑。只用得到内建模块,所以不需要能
# 被解析到 app 的 node_modules。
#
# ## 为什么不用 `ln -s node_modules`
#
# `banner` 给的 `require` 是从 **bundle 自己的位置**解析的,而这一套经 `require.resolve`
# 找 `@anthropic-ai/claude-agent-sdk/manifest.json`(拿捆绑的 CLI 版本号去卡 Concise
# 那个内置风格)。bundle 在 `mktemp -d` 出来的目录里、够不着 `node_modules` —— 那时
# `bundledCliVersion()` 按设计返回 null,等价于"不卡版本",所以五项内置全在。断言就是
# 按那个写的(见 main.ts §10)。**别**因为想让版本号读出来就软链 node_modules:
# 那会让断言依赖机器上装了哪个版本的 SDK。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-settings-panel-smoke.XXXXXX)
HOME_DIR=$(mktemp -d /tmp/mcode-settings-panel-home.XXXXXX)
trap 'rm -rf "$OUT" "$HOME_DIR"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/settings-panel-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/settings-panel-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_HOME="$HOME_DIR"
# 数据根落在隔离的用户根里:两种隔离用同一个临时目录,少一个变量少一处指错的机会。
export MCODE_SMOKE_DATA_ROOT="$HOME_DIR/data"

node "$OUT/smoke.mjs"
