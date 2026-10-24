#!/usr/bin/env bash
# 【O8】docs 换壳开关的真假：真 Electron 双模式判据（宿主换壳 / 独立不换壳）。
# 见 build.mjs / probe.cjs 文件头。
#
# 本套件**必须**用真 Electron：判据是「页面里真的加载了主题层」，读源码证明不了。
# 0014 就是只断言了源码里有 `if (window.desktop)` —— 而那个条件在独立运行时也成立
# （`desktop` 是 docs 自己的 preload 命名空间），所以它承诺的「单独跑不换壳」从未生效，
# 而套件一直是绿的。这一套让同一份构建产物跑两遍，只改 `app.setName()`。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
node "$HERE/build.mjs"
