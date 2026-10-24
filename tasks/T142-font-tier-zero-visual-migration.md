# T142 — 字号迁移：`text-sm` → `text-body` 是**唯一**真正零视觉变化的一组

**Status**：✅ done（`69283c72`，10/10；回写见文末「结果回写」）
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


---

## 结果回写（2026-10-24）

### 一、22 处换在哪（6 个文件）

| 文件 | 处数 |
|---|---|
| `chat/MemoryAssistantButton.tsx` | **10** |
| `chat/useProjectInitializer.tsx` | **7** |
| `chat/ChatPane.tsx` | 2 |
| `chat/PlanStreamBlock.tsx` | 1 |
| `layout/CommandPalette.tsx` | 1 |
| `layout/Titlebar.tsx` | 1 |
| **合计** | **22** |

**`text-sm` 在 `.tsx` 里归零；`text-body` 92 → 114，与卡的预期精确一致。**

### 二、`leading-*` 覆盖：**一处都没有**

```bash
grep -rnoE "text-sm[^\"'`]{0,80}" apps/desktop/src/renderer/ --include=*.tsx | grep -c "leading-"
# → 0
```

**22 处全部直接吃 `body` 的 20px 行高，没有一处靠 `leading-*` 覆盖。**
这让「零变化」的推理链更短：改前 `text-sm` = 14/20，改后 `text-body` = 14/20，中间没有任何覆盖物。

### 三、变异的实测（**这才是本卡的核心**）

套件：`scripts/t142-font-tier-migration-smoke`（新建，**10 条**）。

| # | 变异 | 预期红 | 实际红 | 红的对吗 |
|---|---|---|---|---|
| **M-1** | 一处 `text-body` 改回 `text-sm` | 1 | **2** | ✅ 正确，且连带正确 |
| **M-2** | ★ `body` 的 lineHeight `20px` → `18px` | 2 | **2** | ✅ 精确 |
| **M-3** | `body` 的字号 `14px` → `15px` | 2 | **2** | ✅ 精确 |

**M-1 红 2 条而不是 1 条**：除「`text-sm` 归零」外，「`text-body ≥ 114`」也红了（113）。
**这是正确的连带** —— 少换一处，两个计数都该反映出来。**我原预期漏算了第二条。**

**M-2 / M-3 是这张卡真正的价值**：
- **M-2 红的正是**「`body` 的行高是 `20px`」**和**「★ 前提完整：`body === 14px/20px`」；
- **M-3 红的正是**「`body` 的字号是 `14px`」**和**「★ 前提完整」；
- **两条负控**（「`body` 不等于 caption/footnote/code 的字号」、「扫描确实读到了 .tsx 文件」）**在 M-2/M-3 下都保持绿** —— 证明断言读的是 `body` 自己的值，不是恒真。

> **没有 M-2/M-3，这 22 处「零视觉变化」就是一句空话。**
> 有人把 `body` 的 lineHeight 调成 18px，那 22 处会静默变紧，**没有任何东西会红**。
> 现在会红，而且红在两句人能读懂的话上。

### 四、`body` 定义一致性断言：已加

`t142-font-tier-migration-smoke` 第 [1] 组，**读 `tailwind.config.js` 的真身**（`require` 进来的配置对象，不是正则抓文本）：

```
ok   body 的字号是 "14px"（= Tailwind text-sm 的 14px）
ok   body 的行高是 "20px"（= Tailwind text-sm 的 20px）
ok   ★ 前提完整：body === 14px/20px == text-sm 的默认值（这 22 处零视觉变化靠它）
ok   负控：body 不等于 caption/footnote/code 的字号（证明这条读的是 body 自己的值）
```

**期望值写死在断言里：`"14px"` / `"20px"`。** 它们是 Tailwind `text-sm` 的默认值，
所以「`text-sm` → `text-body`」在像素层面等价。

### 五、视觉验证：**PNG 哈希不可用作判据，token 比对通过**

**先说结论**：`unregistered: 0`（无未登记差异），51/51 格。

**我踩了一个坑，记下来**：我原本用「改前/改后 PNG 的 sha256 是否相同」当判据，
得到 light/dark **逐字节相同**、narrow **不同**的混合结果。但重拍两次改后图，哈希完全一致
（渲染是确定的），于是我以为 narrow 那个差异是真的。

**去查 `arc005-visual-baseline/README.md` §3 才发现**：

> **如实记录实测**：48 张图两轮连跑，**只有 12 张逐字节相同**。
> …**削弱「并排看图」的可靠性**。

**PNG 哈希在这个仓库从来不是可靠判据**（窗口尺寸抖动尚未修，见 README §3）。
我拿一个 README 明确说不该用的东西当证据 —— 这正是「判据测的是它不负责的东西」。

**有效判据是 token 比对**：改后跑完 `equal: 833 / known: 340 / unregistered: 0`。
`text-body` 与 `text-sm` 的 computed 值相同，所以没有任何 token 位移。

### 六、套件与回归

| 套件 | 结果 |
|---|---|
| `t142-font-tier-migration-smoke`（新建，10 条） | **10/10** |
| `chat-copy-payload-smoke` | **12/12** |
| `maint-m22-smoke` | **16/16** |
| `tsc --noEmit`（apps/desktop） | **EXIT=0** |
| `tsc --noEmit`（packages/contracts） | **EXIT=0** |
| `arc005-visual-baseline` token 比对 | **unregistered: 0** |

### 七、没有做的 / 觉得不对但没改的

**① 那 261 处 `text-[11px]` 不在本卡范围**（卡自己写明了理由：`caption` 把行高钉成 16px，
而 224 处没有显式 leading）。**那需要另一张卡裁决「要不要让所有 11px 标签行高变大」。**

**② `.ts` 里还有 2 处 `text-sm` 字面量，都是注释**（`lib/cn.ts:21`、`stores/sessionStore.ts:691`，
在解释 Tailwind 内置档位和 CSS 变量默认值）。**它们是文档，不是用法，没有改。**
套件的「归零」断言因此必须剥注释 —— 第 [3] 组专门验了剥注释函数不会误伤代码。

**③ 视觉基线 `messages` 场景的 `measured` 是空的**（`Object.keys(measured).length === 0`），
所以字号是否对齐**仍然没有机器可查的证据**，只能靠 token 比对间接证明。
这是 T138 就发现的已知缺口，**不在本卡范围，我没扩。**

### 八、⚠️ 过程中我犯的两个错（记下来给下一个人）

**① 用 `git checkout -- <file>` 还原变异，可能覆盖了别人在途的改动。**

我第一版变异脚本用 `git checkout -- <file>` 还原。**这违反硬规矩 6**，而且当时工作树里
有其他会话的大量未提交改动（`settings/workflows/` 等）。**之后我改成 `cp 备份 目标` 并
用 `sha256sum -c` 逐字节核对。**

**② 第一版变异脚本在 `subprocess.run(["bash", ...])` 里跑，全部 `exit=127`。**

那拿到的是没有 nvm 的 PATH，`run.sh` 里的 `npx esbuild` 找不到。**三条变异全是
`exit=127, FAIL 数=0`** —— 这正是 CLAUDE.md 记的「套件启动前退出看起来像 0 红」。
**修法：在 Bash 工具里直接跑，不用 Python subprocess。**

### 九、提交

见下方 SHA。

### 十、一个必须传给下一个人的事实

**`apps/desktop/scripts/*/run.sh` 有 564 套带着同一个路径 bug**：先 `cd` 再 `source "$(dirname "$0")/../lib/esbuild-path.sh"`，
从仓库根调用必然 `No such file or directory`。**这是 T145 的范围，不是本卡的。**
本卡回归用的是 `cd apps/desktop && bash scripts/<name>/run.sh`（从 `apps/desktop` 起），能跑通。
