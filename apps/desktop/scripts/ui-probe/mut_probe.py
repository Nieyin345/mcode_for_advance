"""把 probe.mjs 自己弄坏，看自检会不会红。

一个"永远绿"的核对台毫无价值 —— 所以 probe 本身也要挨这一刀。
每条变异都精确 str.replace 并**数出现次数**（改不到就是静默空过，
会伪装成"断言不管用"），跑完 cmp 逐字节还原。
"""
import pathlib
import subprocess
import sys

# Windows 控制台默认 GBK，中文和 ✓/✗ 都会 UnicodeEncodeError。强制 UTF-8，
# 否则脚本会在"打印报告"这一步崩掉 —— 而那看起来像"变异没跑完"。
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
PROBE = HERE / "probe.mjs"
SELFTEST = HERE / "agentprobe-selftest.mjs"
BAK = HERE / ".probe.mjs.bak"

MUTATIONS = [
    (
        # ⚠️ 早先这条写的是"删掉三元的第一个分支" —— 那会把 `a ? b : c ? d : e`
        # 削成语法错误，进程在**加载**时就死。那不是行为变异，不算数。
        "P1 解码器把 filter 字节当成 0（只做 None）",
        "    const f = raw[y * (stride + 1)];",
        "    const f = 0;",
        ["红方块", "蓝方块", "50% 灰"],
    ),
    (
        "P2 点击只移动不按下",
        '        type: "mousePressed", x, y, button, buttons, clickCount,\n      });\n      await send("Input.dispatchMouseEvent", {\n        type: "mouseReleased", x, y, button, buttons: 0, clickCount,\n      });',
        '        type: "mouseMoved", x, y, button: "none",\n      });',
        ["真鼠标点一下"],
    ),
    (
        "P3 对比度恒返回 21",
        "  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);\n  return (hi + 0.05) / (lo + 0.05);",
        "  return 21;",
        ["浅灰字对比度"],
    ),
    (
        "P4 hitTest 永远说命中的是 body",
        "        if (!el) return JSON.stringify({ found: false, why: \"这个坐标上没有任何元素\" });",
        "        if (!el) return JSON.stringify({ found: false, why: \"这个坐标上没有任何元素\" });\n        if (el) return JSON.stringify({ found: true, tag: \"body\", id: null, cls: null, text: \"\", inViewport: true });",
        ["命中的是那个按钮"],
    ),
    (
        "P5 inkRatio 恒返回 0",
        "      return all === 0 ? 0 : ink / all;",
        "      return 0;",
        ["菜单里确实有非底色的墨"],
    ),
    (
        "P6 el() 永远说不是零宽",
        "          zeroBox: r.width === 0 || r.height === 0,",
        "          zeroBox: false,",
        ["空的行内元素才是零宽"],
    ),
    (
        "P7 右键无条件再补一发（旧行为）",
        "      let synthesized = false;\n      if (!(await raw(\"window.__ctxCount\"))) {",
        "      let synthesized = false;\n      if (true) {",
        ["右键恰好触发一次"],
    ),
]


def run_selftest():
    p = subprocess.run(
        ["node", str(SELFTEST)],
        cwd=HERE,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    out = p.stdout + p.stderr
    fails = [l for l in out.splitlines() if l.strip().startswith("FAIL")]
    summary = next((l for l in out.splitlines() if "通过 ·" in l), None)
    # 变异把源码改成语法错误的话，进程在**加载**时就死 —— 那不是行为变异，
    # 不算被抓住。必须和"跑起来但断言不管用"分开，否则一条废变异会伪装成通过。
    syntax = "SyntaxError" in out or "Unexpected token" in out
    return p.returncode, fails, summary, syntax


def main():
    restore_only = "--restore" in sys.argv
    if BAK.exists():
        PROBE.write_bytes(BAK.read_bytes())
        if restore_only:
            print("已从备份还原 probe.mjs")
            return 0
    elif restore_only:
        print("没有备份可还原")
        return 1
    else:
        BAK.write_bytes(PROBE.read_bytes())

    orig = BAK.read_text(encoding="utf-8")
    print("=== 基线 ===")
    code, fails, summary, syntax = run_selftest()
    print(f"  退出码 {code} · 红 {len(fails)} 条 · {summary}")
    if fails:
        print("  ⚠️ 基线就是红的，下面全是噪声")
        for f in fails:
            print("   ", f.strip())

    bad = 0
    for name, old, new, expect in MUTATIONS:
        if orig.count(old) != 1:
            print(f"\n=== {name} ===")
            print(f"  ✗ 变异没生效：模式出现 {orig.count(old)} 次（要 1 次）")
            bad += 1
            continue
        PROBE.write_text(orig.replace(old, new), encoding="utf-8")
        code, fails, summary, syntax = run_selftest()
        PROBE.write_bytes(BAK.read_bytes())

        hit = [f for f in fails if any(e in f for e in expect)]
        caught = bool(hit) and not syntax
        if not caught:
            bad += 1
        print(f"\n=== {name} ===")
        if syntax:
            print(f"  ✗ 变异改出了语法错误（退出码 {code}）—— 这不是行为变异，不算数")
        else:
            print(f"  {'✓' if hit else '✗'} 退出码 {code} · 红 {len(fails)} 条 · {summary or '没跑到收尾(崩了)'}")
        for f in hit:
            print("    →", f.strip())
        if not syntax and not hit and summary is None:
            print("    → 进程真的崩了（算被抓住，但要确认崩在断言上还是别处）")

    # 逐字节还原
    PROBE.write_bytes(BAK.read_bytes())
    same = PROBE.read_bytes() == BAK.read_bytes()
    print(f"\n还原逐字节一致：{'是' if same else '否 —— 源文件没恢复!'}")
    print(f"变异 {len(MUTATIONS) - bad}/{len(MUTATIONS)} 条被抓住")
    return 0 if (bad == 0 and same) else 1


if __name__ == "__main__":
    sys.exit(main())
