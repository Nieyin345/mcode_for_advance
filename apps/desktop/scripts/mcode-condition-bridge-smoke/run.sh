#!/usr/bin/env bash
# W17：条件迁到 Node-RED 之后「谁写真值」的回归网。
#
# 纯逻辑 + **真上游 10-switch.js 原文**（进程内加载，不起引擎、不部署）。
# 不起 Electron、不碰用户数据根。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/mcode-condition-bridge.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo 'Installed esbuild not found; no network install attempted.' >&2; exit 1; fi

# 本套件的 import 链（flowMigration / conditionHost / mcodeNodeTypes / nodeTypes）
# 会经 `nodeTypes` / `builtinManifestById` 拖进 dataRoot/logger（两者 import
# electron）。与其它无头主进程套件一致：换桩，并给 esbuild 一个 require shim。
#
# ESM 输出：主文件用 top-level await 读上游 switch 原文（cjs 输出不支持 TLA）。
# 上游 10-switch.js 是 CJS，但本套件**读它的字节**并用 `new Function` 执行 ——
# 不需要 require 那个文件本身，所以 ESM 输出与它不冲突。
mcode_esbuild scripts/mcode-condition-bridge-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# cwd 必须是 apps/desktop（上游 10-switch.js 的路径相对它解析）。
node "$OUT/smoke.mjs"
