#!/usr/bin/env bash
# Headless smoke for **`main/ipc/institutionAuth.ts`**(设置 → 机构认证那条 IPC)。
#
# 这一套押在"用户以为发生了 A、实际发生了 B"的那类错上:
#
#   - **清太多**:`domains: []` 曾经和"省略 domains"走同一条路 = 清空整个浏览器分区。
#     调用方给了一个明确的空列表,收到的是全量登出 —— 而两种结果在返回值上长得一模一样;
#   - **清太少**:界面说"已清除",同域别的 cookie 一条没少,第二天还是登录着的;
#   - **凭证明文漏出去**:cookie 的 value 就是凭据,读状态/清完后的返回体里一条都不该有;
#   - **把失败当成功**:cookie 存储报错被吞掉,用户看着"已清除"却还在已登录状态。
#
# ## 换桩的边界
#
#   - `@main/browser/BrowserManager.js` —— `stubs/browserManager.ts`,**可控的假 cookie
#     存储**(不是纯抛型):能喂带前导点的父域 cookie、会话 cookie、没有 domain 的条目,
#     也能让 clear 抛一次。这一套的外面就是这一层,喂不进去就什么都验不了。
#     那个桩里的 `get`/`clear` 匹配规则是**真起一次 Electron 实测抄来的**,理由写在它的
#     文件头上。
#   - `@main/lib/dataRoot.js` / `@main/lib/logger.js` —— 复用 run-store-smoke 的两份桩。
#   - `@main/store/repositories.js` 用**真的**:档案要真写进库、真读回来。
#
# ⚠️ **数据根必须是 `mktemp -d`。** 这一套真建库、真写 `institution_profiles` 行(内部
# 都是 `persist()`,`sql.js` 的 `db.export()` **重写整个 mcode.db**)。指到用户真库等于
# 毁数据。`stubs/dataRoot.ts` 那句"没设环境变量就抛"就是为这件事 —— 别去改它。
#
# ⚠️ `--alias:` **只认包名**,相对路径的 import 换不掉。所以这里一条 `--external` 都
# 不用 —— 混搭会产生两份模块实例,共享状态对不上,大面积假红。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-institution-auth-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-institution-auth-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")`,而定死的
# ESM 输出**没有 `require`** —— esbuild 会把它换成一句 `throw new Error(...)`。
"$ESBUILD" scripts/institution-auth-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/browser/BrowserManager.js=./scripts/institution-auth-smoke/stubs/browserManager.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
