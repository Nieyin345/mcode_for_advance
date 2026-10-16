#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Node 22.13+ transforms the adapter's TypeScript parameter properties in place;
# the other fixture transpiles only the Codex resolver to isolate its pnpm probe.
# --import 挂 .js→.ts 解析钩子(见 ts-js-resolve-hook.mjs —— 适配器链上从 MC-009
# 起有了第一个值级跨模块导入,Node 的 ESM 解析不认 tsconfig 的 .js 后缀约定)。
node --experimental-transform-types \
  --import ./scripts/engine-regressions-smoke/hook-register.mjs \
  scripts/engine-regressions-smoke/main.mjs
