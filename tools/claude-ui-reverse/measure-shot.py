"""从 Claude 全窗口截图里量出各区域的边界。

做法：沿水平/垂直方向扫「颜色突变」，找出侧栏、标题栏、内容区、右面板的分界。
不猜语义 —— 只报「这里有一条线」，再由人对着 CSS 里的已知值判断它是什么。
"""
import io
from PIL import Image
import numpy as np

im = Image.open(".tmp/rev/claude-shot.webp").convert("RGB")
W, H = im.size
a = np.asarray(im, dtype=np.int16)
print(f"画布 {W} x {H}")
print()

# ── 一、主底色（取左上角一小块的众数）──
def mode_color(region):
    r = region.reshape(-1, 3)
    vals, counts = np.unique(r, axis=0, return_counts=True)
    return tuple(vals[counts.argmax()])

bg = mode_color(a[0:40, 0:40])
print("左上角底色:", bg)

# ── 二、沿 y=中间 横着扫，找竖向分界 ──
def scan_axis(axis, fixed, label):
    """axis='x' 时沿 x 扫，fixed 是 y。返回颜色变化处。"""
    if axis == "x":
        line = a[fixed, :, :]
    else:
        line = a[:, fixed, :]
    diffs = np.abs(np.diff(line, axis=0)).sum(axis=1)
    idx = np.where(diffs > 6)[0]          # 阈值 6：比 JPEG 噪点大，比真实边界小
    # 合并相邻
    groups = []
    for i in idx:
        if groups and i - groups[-1][-1] <= 2:
            groups[-1].append(i)
        else:
            groups.append([i])
    print(f"\n{label}（沿 {'x' if axis=='x' else 'y'} 扫，fixed={fixed}）")
    for g in groups:
        p = int(np.mean(g))
        before = tuple(int(v) for v in line[max(0, p - 3)])
        after = tuple(int(v) for v in line[min(len(line) - 1, p + 3)])
        print(f"  pos={p:5d}  {before} → {after}")
    return [int(np.mean(g)) for g in groups]

scan_axis("x", H // 2, "横切（找左右分界）")
scan_axis("y", W // 2, "纵切（找上下分界）")
