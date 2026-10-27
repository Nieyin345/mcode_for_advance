"""
抽「图标名字」清单。

图标 path 静态拿不到（见 extract-icons.mjs 的说明），但**名字**能拿到 ——
调用点长这样：`y(Re,{name:"ArrowReturn",size:"sm"})`。
名字本身就是结构信息（哪些动作配了图标、图标叫什么），画的时候照名字找近似图形即可。

判据：只收「出现在 `name:"X"` 且同一对象里有 `size:` / `icon:` / `aria-label`」的，
避免把 `defaultMessage` / `title` 里的普通名词混进来。
"""
import io, os, re, json

D = r"C:/Program Files/WindowsApps/Claude_3.6556.2.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1"
OUT = r"D:/副桌面/文件夹/work_space/work_for_reseach/mcode/.tmp/rev/icon-names.txt"

# 图标组件常见的 prop 组合
pat = re.compile(
    r'\{[^{}]{0,400}?name\s*:\s*"([A-Z][A-Za-z0-9]{2,32})"[^{}]{0,400}?'
    r'(?:size\s*:|icon\s*:|"aria-label"\s*:)'
)
pat2 = re.compile(
    r'icon\s*:\s*"([A-Z][A-Za-z0-9]{2,32})"'
)
pat3 = re.compile(
    r'icon\s*:\s*[A-Za-z_$][\w$]*\s*\?\s*"?([A-Z][A-Za-z0-9]{2,32})"?\s*:'
)

names = {}
for f in sorted(os.listdir(D), key=lambda x: -os.path.getsize(os.path.join(D, x))):
    if not f.endswith(".js"):
        continue
    p = os.path.join(D, f)
    try:
        s = io.open(p, encoding="utf-8", errors="replace").read()
    except OSError:
        continue
    for m in pat.finditer(s):
        names.setdefault(m.group(1), f)
    for m in pat2.finditer(s):
        names.setdefault(m.group(1), f)
    for m in pat3.finditer(s):
        names.setdefault(m.group(1), f)

# ⚠️ 上一版的 BAD 规则**误杀了真图标**：
#   它用小写单字母匹配（^e$ / ^t$ …），但匹配是**大小写不敏感之外**的——
#   实际是把 `Edit`（首字母 E）、`Eye`、`Home`、`Menu`、`Moon` 这类
#   **正常图标名**也判成了变量名，因为它们**恰好以那些字母开头**。
#
# 现在的判据：只排除**真的**不是图标的形状 ——
#   1. 日期/时间格式串（含 `y`/`M`/`d`/`H`/`m`/`s`/`a`/`E` 的 ICU 模式）
#   2. 单个字母、或「字母+数字」的短变量名（≤3 字符且无元音）
BAD = re.compile(
    r"^(Gy|yMd|yMMMd|yMMMEd|yMMMd|MMMEd|MEd|Md|hmm|Hm|ms|Ed)[A-Za-z]*$"
    r"|^[a-z]{1,3}\d?$"
)
# 额外：这些**是**真图标，白名单保住
KEEP_ALWAYS = {
    "Edit", "Eye", "Home", "Menu", "Moon", "Sun", "Mail", "Link",
    "Copy", "Lock", "User", "Info", "Plus", "Check", "Close", "Search",
}

kept = {k: v for k, v in names.items() if (k in KEEP_ALWAYS) or not BAD.match(k)}
dropped = sorted(set(names) - set(kept))

lines = [
    "Claude 3.6556.2.0 —— 图标名字（不含 path）",
    "",
    "⚠️ path 静态拿不到（图标是编译期组件，表被 minify）。",
    "   这里只有**名字** —— 画的时候按名字找近似图形。",
    "",
    f"共 {len(kept)} 个（已滤掉 {len(dropped)} 个明显不是图标的）",
    "",
]
for k in sorted(kept):
    lines.append(f"  {k}")

io.open(OUT, "w", encoding="utf-8").write("\n".join(lines) + "\n")
io.open(OUT.replace(".txt", ".json"), "w", encoding="utf-8").write(
    json.dumps({"icons": sorted(kept), "dropped": dropped}, ensure_ascii=False, indent=2))

print(f"保留 {len(kept)} 个图标名")
print("  " + "  ".join(sorted(kept)[:60]))
print(f"\n滤掉 {len(dropped)} 个：{dropped[:20]}")
