"""从 Claude 全窗口截图里量**不可拖动**的量。

## 用户指出的问题

上一版用「侧栏 288px」反推 DPR —— **方向错了**：
侧栏和右面板都是**可拖动**的，它们的宽度取决于用户当前拖到哪，
不是固定值。拿它们反推 DPR，等于拿一个变量当常数。

## 这一版量什么

只量**不随拖动变化**的东西：

  1. 字体 —— 正文行高（同一段多行文字，行距是固定的）
  2. 组件内边距 —— 按钮/行内的留白
  3. 图标尺寸
  4. 元素固定高度 —— 标题栏、分段控件

判据：**这些在 CSS 里都有确定值**，量出来能直接对。

## 怎么量

不靠肉眼估：找「同一列上连续多行的前景像素中心」，行距就是相邻中心的差。
"""
import io
from PIL import Image
import numpy as np

im = Image.open(".tmp/rev/claude-shot.webp").convert("RGB")
a = np.asarray(im, dtype=np.int16)
H, W, _ = a.shape
print(f"画布 {W} x {H}")

def darkness_rows(x0, x1, y0, y1, thresh=140):
    """一个矩形区域内，每行有多少深色像素 —— 用来找文字行的位置。"""
    block = a[y0:y1, x0:x1]
    # 亮度
    lum = block.mean(axis=2)
    return (lum < thresh).sum(axis=1)

def find_text_lines(x0, x1, y0, y1, thresh=140, min_px=3):
    """返回文字行的中心 y（相对 y0 的绝对值）。"""
    counts = darkness_rows(x0, x1, y0, y1, thresh)
    rows = np.where(counts >= min_px)[0]
    if len(rows) == 0:
        return []
    groups = []
    for r in rows:
        if groups and r - groups[-1][-1] <= 2:
            groups[-1].append(r)
        else:
            groups.append([r])
    return [(y0 + int(np.mean(g)), len(g)) for g in groups]

# ── 一、正文行距：取内容区中一段多行文字 ──
# 截图上正文从约 y=90 开始，x 从 640 起。取一个较宽的窄条避开缩进与列表符号。
print("\n=== 正文文字行（内容区 x=640..1500, y=80..900）===")
lines = find_text_lines(640, 1500, 80, 900, thresh=150, min_px=8)
print(f"找到 {len(lines)} 个文字行带")
prev = None
gaps = []
for y, h in lines:
    d = (y - prev) if prev is not None else 0
    if prev is not None and d < 200:
        gaps.append(d)
    print(f"  y={y:5d}  带高={h:3d}  与上一行距={d if prev is not None else '-'}")
    prev = y

if gaps:
    gaps_sorted = sorted(gaps)
    med = gaps_sorted[len(gaps_sorted) // 2]
    print(f"\n行距中位数 = {med} 像素")
    for dpr in (1.25, 1.5, 1.75, 2.0, 2.25, 2.5):
        print(f"  DPR={dpr}: {med/dpr:.2f} css px")
