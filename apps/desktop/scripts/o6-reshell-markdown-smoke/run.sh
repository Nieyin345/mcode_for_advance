#!/usr/bin/env bash
# 【O6】Markdown 换壳：真 Electron 双模式判据（宿主换壳 / 独立不换壳），
# 外加「预览纸张与正文墨色不被换壳带走」那一组。见 build.mjs / probe.cjs 文件头。
#
# 本套件**必须**用真 Electron 二进制：判据是「页面里真的加载了主题层、token 真的生效」，
# 读源码证明不了这件事 —— 0014 就是只读源码，守卫失效而套件全绿。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
node "$HERE/build.mjs"
