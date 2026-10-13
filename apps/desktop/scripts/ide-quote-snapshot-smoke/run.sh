#!/usr/bin/env bash
# ide-quote-snapshot-smoke —— MC-098「引用正文与行号必须同出一份冻结快照」(见 main.ts 头)。
# 打包与替身在 build.mjs 里(esbuild 插件换掉重量级子件)。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/ide-quote-snapshot-smoke/build.mjs
