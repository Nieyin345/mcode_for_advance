#!/usr/bin/env bash
# 全量 smoke。**改一处小东西时别跑这个** —— 跑覆盖那几套就够了:
#
#   bash apps/desktop/scripts/smokes-for.sh <改动的文件>      # 哪几套覆盖它
#   bash apps/desktop/scripts/smokes-for.sh --all             # 全部文件→套件 的映射
#
# 全量留给"提交前"和"改动跨了模块"这两件事。它慢,而每个小改动都等它几分钟的代价
# 不是时间本身 —— 是人开始攒着改,而攒着改是 bug 的温床。

# 一次跑完所有 headless smoke(suite 失败不影响后面的继续跑)。
#
# 每个套件的输出留在 /tmp/smoke_<name>.log,控制台只打一行结果,失败时贴最后几行。
# 想单独看某个: bash scripts/<name>-smoke/run.sh
#
# 单套件超时 240s:smoke 都是秒级完成的,卡 4 分钟基本是挂在一个永远不会回来的
# 等待上(比如等一个根本没起来的服务),不如让它超时、把结果记成 FAIL。
set -u
# $0 可能是相对路径(scripts/run-all-smokes.sh),先钉死成绝对路径再跳:
# scripts/ 的上一级就是 apps/desktop,后面所有 smoke 的 run.sh 都以它为基准。
APP_DIR="$(cd "$(dirname "$0")" && pwd)/.."
cd "$APP_DIR"

pass=0; fail=0; failed=""
for d in scripts/*-smoke; do
  n=$(basename "$d")
  log="/tmp/smoke_${n}.log"
  if timeout 240 bash "$d/run.sh" >"$log" 2>&1; then
    pass=$((pass+1)); echo "PASS  $n"
  else
    c=$?
    fail=$((fail+1)); failed="$failed $n"
    echo "FAIL  $n (exit $c) — /tmp/smoke_${n}.log 最后几行:"
    tail -n 5 "$log" | sed 's/^/      /'
  fi
done

echo
echo "smoke 汇总: $pass pass, $fail fail${failed:+ (failed:$failed)}"
exit $((fail == 0 ? 0 : 1))
