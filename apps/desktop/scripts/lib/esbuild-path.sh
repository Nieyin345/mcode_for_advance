#!/usr/bin/env bash
# 解析 esbuild 可执行文件的路径 —— **被所有 smoke 的 run.sh `source`**。
#
# ## 为什么有这个东西
#
# 从前每个 run.sh 各自写一句:
#   ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f | sort -V | tail -1)
# `find` 会**递归扫遍 `.pnpm` 上千个包目录**,在这台机器上一句要 **2.4～4.5 秒**;而 esbuild
# 打包本身只要 ~0.16 秒。138 个 run.sh 各跑一次 = **5～10 分钟纯花在"找工具"上**,
# 不是干活。`readdirSync` 只看 `.pnpm` 顶层(包名目录),**0.14 秒** —— 快 30 倍。
#
# ## 怎么用
#
#   source "$(dirname "$0")/../lib/esbuild-path.sh"
#   "$ESBUILD" ...
#
# 解析顺序(先快后稳):
#   1. 环境变量 MCODE_ESBUILD(调用方/CI 直接给,最省) —— 命中即返回;
#   2. `.tmp/esbuild-path` 缓存(run-smokes.mjs 预解析一次写进去,全量跑共享);
#   3. `.pnpm` 顶层 glob(`esbuild@*`,0.14s) —— 常规快路径;
#   4. `find` 递归兜底(万一 pnpm 布局变了)。
# 解析不出来(未安装)就回落 `npx esbuild`,与从前一致。
#
# ⚠️ 本文件**必须**被 `source`,不能 `bash` 执行(那样变量传不回来)。

# 1) 环境变量直给
if [[ -n "${MCODE_ESBUILD:-}" && -x "$MCODE_ESBUILD" ]]; then
  ESBUILD="$MCODE_ESBUILD"
  return 0 2>/dev/null || exit 0
fi

# 2) 缓存(run-smokes.mjs 全量跑时预解析)。路径相对本文件,与调用方 cwd 无关。
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_CACHE="$_LIB_DIR/../../.tmp/esbuild-path"
if [[ -f "$_CACHE" ]]; then
  _CACHED="$(cat "$_CACHE" 2>/dev/null)"
  if [[ -n "$_CACHED" && -x "$_CACHED" ]]; then
    ESBUILD="$_CACHED"
    return 0 2>/dev/null || exit 0
  fi
fi

# 3) `.pnpm` 顶层 glob(快路径)。相对仓库根解析 —— 本文件在 apps/desktop/scripts。
_ROOT="$_LIB_DIR/../.."          # → apps/desktop
_PNPM="$_ROOT/../../node_modules/.pnpm"
ESBUILD=""
if [[ -d "$_PNPM" ]]; then
  # shellcheck disable=SC2012  # 目录名可控,ls 够用且比 find 快 30 倍
  _HIT="$(ls -d "$_PNPM"/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$_HIT" && -x "$_HIT" ]]; then ESBUILD="$_HIT"; fi
fi

# 4) 递归兜底(布局变了才走到)
if [[ -z "$ESBUILD" ]]; then
  _FOUND="$(find "$_PNPM" -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$_FOUND" && -x "$_FOUND" ]]; then ESBUILD="$_FOUND"; fi
fi

# 5) 都没有 → npx(与从前一致)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi
