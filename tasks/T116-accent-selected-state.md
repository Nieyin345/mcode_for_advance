# T116｜六处「选中态」不再用品牌淡底 —— 以及它们改完还看得见吗

- Status: **done**（`de6cd867`，`design-tokens-smoke` 345/345）
- Category: **P0 产品缺陷（规范违反）+ P1 可辨性**
- Depends on: T114（判据改造，`2f2bebc9`）
- Exclusive writable files: 六个组件文件

## 背景：T114 把判据改对之后，六个文件被正确地判为违规

判据第一次会抓「选中态用 `bg-accent/15`」这类形状（而不是只认两个类紧邻），于是暴露出六处真违规：

| 文件 | 行 | 是什么 |
|---|---|---|
| `chat/AskChoiceDialog.tsx` | 186 | 选项选中 |
| `chat/BranchChoiceCard.tsx` | 127 | 选项选中 |
| `chat/FileMentionPicker.tsx` | 443 | 键盘高亮行 |
| `chat/SlashCommandPicker.tsx` | 314 | 键盘高亮行 |
| `ide/FileTree.tsx` | 1336 | 当前文件 |
| `ide/SearchDialog.tsx` | 647、778 | 结果高亮 |

## 一、D 的第一版改法：套件全绿，但**看不到选中态**

D 最初用 `bg-surface-muted` 作选中底。用真实 token 算对比度：

| 填充色 | 浅色 vs 底色 | 深色 vs 底色 |
|---|---|---|
| `surface-muted`（第一版） | **1.03** | **1.12** |
| `surface-hover`（最终） | 1.12 | 1.31 |

**1.03 等于看不见。**

**而第一版跑 `design-tokens-smoke` 是全绿的** —— **因为那条判据只验「有没有用 accent」，不验「看不看得见」。**

**这是本卡最重要的一条**：**判据正确地阻止了一个错误（用品牌淡底），却没能阻止另一个错误（选中态消失）。**

## 二、⚠️ 总控核实出的一个 D 没发现的问题：深色下 ring 不可见

D 的最终版给 `FileMentionPicker` / `SlashCommandPicker` 加了 `ring-1 ring-inset ring-edge`，理由是「它们的未选中态本来就是 `hover:bg-surface-hover`，如果选中也用同色，鼠标悬停和选中就分不开」。

**但在深色主题下**：

```css
/* apps/desktop/src/renderer/styles.css:296,301 */
--surface-hover: var(--m-gray-750); /* #2c2c2a */
--edge:          var(--m-gray-750); /* #2c2c2a */
```

**两者是同一个颜色。**

**所以那两处的 `bg-surface-hover + ring-edge` 在深色下 ring 完全不可见 —— 悬停和选中仍然分不开。**

**D 的对比度计算发现不了这个**，因为它算的是「颜色 vs 底色」的比值，**不是「两个 token 是不是同一个值」**。

### 这条要修

**三选一（你论证）**：

| 法 | 做法 | 代价 |
|---|---|---|
| **a. 用 `--input-edge`** | 深色下它是 `#383835`，**和 `--surface-hover` 不同** | 语义上它是「输入框边框」，借用可能不合适 |
| **b. 加一个 `--selected-edge` token** | 明确定义「选中态的边框色」，两主题各给一个值 | 改 `styles.css`（token 层），但语义最干净 |
| **c. 不用 ring，用 `font-medium` 或 `bg` 的深一档** | 不依赖边框 | 可能和 `FileTree` / `SearchDialog` 已有的 `font-medium` 重复，分不开 |

**我倾向 b** —— 因为「选中态需要一个和 surface-hover 不同的边框色」这件事**会被下一个做类似 UI 的人再遇到一次**。

**但 b 要改 `styles.css`，那不在你原来的边界里。先报告，我确认后再动。**

## 三、六处各自的形状（D 的最终实现）

| 文件 | 选中态表达 |
|---|---|
| `AskChoiceDialog:186` | `border-content-subtle bg-surface-hover`（vs 静止 `border-edge`） |
| `BranchChoiceCard:127` | 同上 |
| `FileMentionPicker:443` | `bg-surface-hover` + `ring-1 ring-inset ring-edge` |
| `SlashCommandPicker:314` | 同上 |
| `FileTree:1336` | `bg-surface-hover` + `font-medium`、`ring-edge/70` |
| `SearchDialog:647,778` | `bg-surface-hover` + `font-medium` + `ring-edge/70` |

`SearchDialog` 加 ring 是跟随它自己 `:428` 已有的写法。**注意 `ring-edge/70` 是 70% 透明度 —— 在深色下比 `ring-edge` 更不可见。**

## 四、没碰的（D 判断正确）

- `BranchChoiceCard:165`（`picked.length === 0 || busy`）—— **确认按钮可用态，不是选中态**
- `FileTree:184`（复制成功 toast）—— 同理

**这两处正好证明 T114 的判据改造方向是对的：静态上能区分「选中某一项」和「能不能点」。**

## 五、变异

把 `AskChoiceDialog` 改回品牌淡底 → **只有它一个**出现在 offenders 里，其余 5 个不报。还原后 345/345。

## 六、未验证

**没有真机视觉核对。** `genoffice render` 是文档渲染，这几个是 React 组件；预览台不加载真实组件。

**D 做的是静态对比度计算 —— 那是替代证据，不是视觉核对。**

**要真验需要起 Electron，当前约束不允许。**

## 验收判据

1. `design-tokens-smoke` 345/345（已达）。
2. **六处都改，每处保留原有形状**（已达）。
3. **`BranchChoiceCard:165` / `FileTree:184` 不误伤**（已达）。
4. **⚠️ 深色下 ring 可见** —— **未达**。需要 §二 的裁决。
5. **选中态和悬停态可区分**（浅色已达，**深色待 §二**）。

## 边界

- 六个组件文件；
- **如果走 §二 的 b**：`apps/desktop/src/renderer/styles.css`（**先报告**）；
- **不碰** `TaskCenterPanel.tsx` / `deckPatternCheck.ts` / `documentToolRuntime.ts` / `policy.ts`。

## 回写（D，2026-10-24）

**`de6cd867`（6 文件 +9/−7）**，`design-tokens-smoke` 345 ok / 0 FAIL（原 344 ok + 1 FAIL）。

第一版用 `surface-muted` 被自己的对比度计算否掉（1.03 = 看不见），改成 `surface-hover`（1.12 / 1.31）。**这一点很重要：判据全绿时改法仍然可能是错的。**

变异：`AskChoiceDialog` 改回品牌淡底 → 只有它一个报出，其余 5 个不报。

未做：真机视觉核对（需要 Electron）；`settings-panels-electron-smoke`（需 Electron）。
