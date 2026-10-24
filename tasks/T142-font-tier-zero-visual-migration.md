# T142 — 字号迁移：`text-sm` → `text-body` 是**唯一**真正零视觉变化的一组

**Status**：`ready-for-agent`
**Category**：P0 产品主线（UI）
**Depends on**：T121（七档已配，`3604c2e2`）
**写卡时间**：2026-10-24 20:50。**下面前提都是这一刻实测的，读卡时请复核（见 §零）。**

## ⚠️ 写卡人第一版判断错了，已改（保留过程，因为下一个人会犯同样的错）

**第一版写的是「`text-[11px]` → `caption` 是 261 处零视觉变化」。实测推翻：**

```bash
grep -rhoE "text-\[11px\][^\"']{0,60}" .../renderer --include=*.tsx | grep -c "leading-"
# → 37      （261 处里只有 37 处附近有显式行高）
```

**所以 224 处没有显式行高。** `text-[11px]` 的行高走浏览器默认（normal ≈ 13.2px），
而 `text-caption` **把行高钉死成 `16px`**。**换过去行高会变，不是零变化。**

**这个错误值得记下来**：我只看「字号一样」，没看「行高不一样」。**字号档位同时定死两者**
（`tailwind.config.js` 里 `caption: ["11px", { lineHeight: "16px" }]`），所以任何
「字号相同 → 零变化」的推理都是错的。

## 零、先核三件事（**写卡人已跑过，但结论会过期**）

```bash
# 1. 七档现在有没有定义
grep -n "caption:\|body:\|prose:" apps/desktop/tailwind.config.js

# 2. 各档用量（写卡时：caption 39 / footnote 7 / body 92 / prose 0 / heading 2 / title 0）
for c in text-caption text-footnote text-body text-prose text-heading text-title; do
  echo "$c: $(grep -rho "\b$c\b" apps/desktop/src/renderer/ --include=*.tsx | wc -l)"
done

# 3. 硬写 px 的分布（写卡时实测）
grep -rhoE "text-\[[0-9.]+px\]" apps/desktop/src/renderer/ --include=*.tsx | sort | uniq -c | sort -rn
```

**写卡时实测分布**：

| 写法 | 处数 | 对应七档 | 替换后视觉变化 |
|---|---|---|---|
| `text-sm` | **22** | `body`（14/20） | **零**（字号 + 行高都相同） |
| `text-[11px]` | 261 | `caption`（11/16） | **会变**（行高 13.2→16） |
| `text-[12px]` | 50 | `footnote`（12/**14**）或 `code`（12/**16**） | **会变** |
| `text-[10px]` | 187 | **无对应**（七档最低 11px） | — |
| `text-[9px]` | 41 | **无对应** | — |
| `text-[13px]` | 45 | **无对应** | — |
| `text-[15px]` | 4 | `prose`（15/22） | 可能 |

## 一、这张卡**只做那 22 处 `text-sm` → `text-body`**

`text-sm` 是 Tailwind 默认（**14px / 20px**），`body` 是（**14px / 20px**）。
**两者字号和行高都相同 —— 这是唯一一组真正像素级零变化的替换。**

**为什么值得做**：它不改变任何像素，但把「Tailwind 默认阶梯」这一套从代码里削掉一块，
后续迁移有了一致的锚点。做完之后 `text-body` 的用量从 92 变成 114，
下一个人看到「body 已经有人在用」，不需要再判断该不该用。

**为什么不做那 261 处**：行高会变 2.8px，那是**用户看得见的变化**，需要单独裁决
（该不该让所有 11px 的标签行高变大）。**那是另一张卡，不是这张。**

## 二、执行

**22 处，直接替换 `text-sm` → `text-body`。**

**但每一处仍要看一眼**：`text-sm` 后面有没有紧跟一个 `leading-*`？

```bash
grep -rnoE "text-sm[^\"']{0,40}" apps/desktop/src/renderer/ --include=*.tsx | grep "leading-"
```

**如果有 `leading-*`**，说明那一处已经显式覆盖了行高，换成 `body` 后 `leading-*` 仍然生效，
**结果不变** —— 可以换，但要在回写里记一笔「这处靠 leading 覆盖」。

## 三、验收

1. **`text-sm` 用量 = 0**（全部变成 `text-body`）。
2. **`text-body` 用量 = 原来的 92 + 22 = 114**（写卡时基数；执行时重新数）。
3. **零视觉变化**：改前/改后视觉基线 PNG 对比，`messages-light/dark-1280` **应当一致**
   （允许时钟秒位等已知噪声，见 `arc005-visual-baseline/README.md` §3）。
4. **不回归**：`smokes-for.sh` 查出的套件全绿 + 双包 typecheck。

## 四、变异（**必须做**）

| 变异 | 预期红 |
|---|---|
| 故意留一处 `text-sm` 不换 | 1（用量 = 0 断言） |
| 把 `body` 的 `lineHeight` 从 20px 改成 18px | 1（与上游矩阵的一致性断言，如果有的话；没有就**先加一条**） |

**⚠️ 第二条是本卡的价值所在**：`text-sm → body` 之所以零变化，**完全依赖**
`body` 的定义恰好等于 Tailwind 的 `text-sm`。**这个前提没有任何断言守着。**
执行者**要加一条**：从 `tailwind.config.js` 读出 `body` 的字号行高，
断言它 `=== ["14px","20px"]`。否则哪天有人调了 `body`，这 22 处会**静默变化**，
而「零视觉变化」的结论就悄悄失效了。

## 五、边界

**可以改**：
- `apps/desktop/src/renderer/**/*.tsx` 里的 `text-sm` className
- `apps/desktop/scripts/t142-*/`（新建套件）

**不许碰**：
- `tailwind.config.js` 的七档定义（那是对照上游的权威值，改了整套失效）
- `styles.css` 的 token
- `lib/i18n/**`（另一个会话在改 settings 词典）
- `components/settings/workflows/**`（工作流总控在改）
- `components/ide/TaskCenter*`（另一个会话在改）

**⚠️ 冲突提醒**：动某个文件前先 `git status --porcelain -- <文件>`，
有 `M` 就是别人在途中，**换一个文件做**，不要等也不要顺手改。

## 六、Required Skills

- `mcode-smoke` —— 需要它那套「先写断言、再变异验证」的做法。

## 七、回写

1. 实际换了多少处、分布在几个文件。
2. **有几处靠 `leading-*` 覆盖行高**（列出文件与行号）。
3. 变异实测红了几条、红的哪条。
4. **`body` 定义一致性断言加了吗、断言的期望值是什么。**
5. 视觉基线对比结论（**PNG 有差异就说明某处不是零变化，要查出来**）。
6. 提交 SHA。

## 八、这张卡为什么值得单独开

**K 在 T134 踩过同一个坑**：他第一版断言写「fallback 的值全是 42rem」，
**没断言数量是 7** —— 8 处全写成 42rem 时它照样绿。**他补上数量后才红。**

**这张卡的结构和那次一样**：
- 「零视觉变化」是**这个迁移的全部价值**；
- 而这个价值**依赖一个没有任何断言守着的前提**（`body` 的定义）；
- **所以本卡的变异第一条不是「删代码」，是「改前提」** ——
  把 `body` 的 lineHeight 改掉，看那 22 处会不会静默变化而没人发现。

**如果那条断言写不出来，这张卡就不该开工** —— 因为「零变化」就成了空话。

