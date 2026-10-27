# T146 — 视觉基线量不到右栏，所以右栏的 UI 改动只能靠肉眼

**状态**：`ready-for-agent`
**写卡时间**：2026-10-24 21:20（**本卡所有事实断言都标了取证命令，读卡时先跑一遍**）
**来源**：T141 修好格数门禁后，第一次真正读到 `measured` 数据时发现

## 一、症状

T136 给基线加了四个**我们独有**的右栏场景（`files-pane` / `git-pane` / `taskcenter` / `workflow-board`），
它们能拍出 PNG，`checks.json` 也报 `PASS`。**但 `measured` 里没有一个右栏元素。**

取证（写卡人已跑过，2026-10-24 21:19）：

```bash
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(".tmp/arc005-visual/taskcenter-light-1280.json","utf8"));
for(const m of j.snapshot.measured){if(!m.present)continue;console.log(m.name,m.bounds.x,m.bounds.width)}'
```

**实测输出**（`taskcenter-light-1280`，右栏本该是打开状态）：

| 选择器 | x | width | 是什么 |
|---|---|---|---|
| `sidebar` | 0 | 256 | **左栏** |
| `panel` | 0 | 256 | **也是左栏**（见下） |
| `main` | 280 | 744 | 中间 |
| `card` | — | — | 主区里的元素 |

**没有任何一条落在右栏（x ≈ 1024~1280 区间）。**

### `panel` 这条为什么骗人

```ts
["panel", "[data-testid='workspace-sidebar'], [data-testid='right-panel']"],
```

`querySelectorAll` 按**文档顺序**返回，左栏在前 —— 所以只要左栏存在，这条**永远匹配左栏**，
`[data-testid='right-panel']` 一次都不会被用到。

**而右栏根本没有 `data-testid="right-panel"`。** 它用的是 `data-cds-aside`
（`components/layout/ThreePaneLayout.tsx:436`）。

**所以这是一个「名字说两边、实际只看左边」的选择器** —— `CLAUDE.md` 里「判据的名字可以比它检查的范围大」的又一个实例。

## 二、为什么这是真问题，而不是「覆盖面不够」

**因为它决定了今天所有 UI 结论的取证方式。**

T138（任务中心对齐）的回写里写着：

> **基线抓到了我引入的回归** …… 筛选条从 2 行变成 3 行

但 `compare.mjs` **只比 root token，不比 `measured`**（`compare.mjs:109` 读的是 `sample.snapshot.tokens`）。
所以那次「抓到」**是人眼看 PNG，不是判据**。

**结论碰巧是对的，但取证链是断的。** 下一次没人盯着看图时，同样的回归会静默通过。

**这不是「以后再说」的事**：T142（字号迁移）正在改 659 处硬写字号，其中相当一部分在右栏。
**没有右栏的测量数据，改完之后没有任何机器判据能说「变好了还是变坏了」。**

## 三、要做什么

### 第一步：给右栏加测量选择器（这是本卡的核心）

在 `probe-assertions.ts` 的 `ARC005_MEASURE_SELECTORS` 里加**右栏专属**的名字，
**并且修掉 `panel` 那条骗人的选择器**。

**建议加的**（先核实实际 DOM，别照抄）：

| 名字 | 选择器 | 为什么要 |
|---|---|---|
| `aside` | `[data-cds-aside]` | 右栏容器本身：宽度、圆角、边框、底色 |
| `aside-row` | `[data-cds-aside] li[data-task-id], [data-cds-aside] li` | 列表行（任务行真的是 `<li data-task-id>`，`TaskCenterPanel.tsx:581`） |

**⚠️ 不要用 `[class*='rounded']` 当卡片选择器。**

写卡人第一版写的是 `aside-card: [data-cds-aside] [class*='rounded']` —— **那是错的**，
原因是它会把**所有**带 `rounded` 类名的元素都收进来，包括 `rounded-full` 的药丸和圆点。

**结果会是**：判据「所有 `aside-card` 的圆角 ∈ token 集合」被 `rounded-full`（9999px）撞红，
而那是**正确用法**。于是下一个人会把这条判据删掉 —— **一条误报的判据比没有判据更坏**。

**卡片如果要量，先确认真实的结构性标记**（`data-*` 属性或具名 class），再写选择器。
**找不到稳定标记就说明这一项现在量不了** —— 如实写进回写区，不要凑一个宽选择器上去。

**`panel` 那条怎么改**（两条路，选一条并写明理由）：

- **拆成两条**：`sidebar` / `right-panel`，各自独立；或
- **只留 `sidebar`** 并改名，把右栏交给新的 `aside`。

**⚠️ 不要只加不减。** 留着 `panel` 这条会继续制造「我有测量右栏」的错觉。

### 第二步：把 `measured` 纳入 `compare.mjs` 的判据

**这是本卡真正难的一半，也是它值钱的地方。**

现在 `compare.mjs` 只比 **root token**（`--surface` 这些）。`measured` 里那些
`fontSize` / `borderRadius` / `backgroundColor` **完全没有判据**，只是被记下来。

**要做的是「跨场景不变量」**，不是「和 Claude 逐像素比」（那没有 Claude 的图，做不了）：

| 不变量 | 判据 | 为什么它抓得到回归 |
|---|---|---|
| **同一 token 在所有场景同值** | `--edge` 在 51 格必须一致 | 已经由 root token 比对覆盖，验证它别退化 |
| **同类元素同字号** | 所有 `aside-row` 的 `fontSize` 必须 ∈ 七档 | T142 迁移漏一处就会红 |
| **同类元素同圆角** | 所有 `aside-card` 的 `borderRadius` 必须 ∈ token 集合 | 裸 `rounded-md` 会红 |
| **右栏真的被量到了** | 四个右栏场景里 `aside.present === true` | **这条是本卡的负控**，见下 |

**⚠️ 第三条要有明确的 token 集合来源，不能手抄。** 从 `styles.css` 读
`--radius-btn-xs` / `-md` / `--radius-panel` / `--radius-dialog` / `--radius-code` 的**计算值**，
不要写一串硬编码的 `6px`/`8px`/`10px`（那又是一处会过期的常量）。

### 第三步：负控 —— 证明这套判据真的在看右栏

**没有这一步，前两步等于没做。**

`CLAUDE.md` 第二十六/二十八条：**所有「否定断言」都要配正控**，而且
**「格数对、内容缺」只能靠专门的一条抓**。

## 四、验收

1. **`aside.present === true`** 在 `files-pane` / `git-pane` / `taskcenter` / `workflow-board` 的**全部 9 格**（3 条件 × 3 场景 + 1）成立。
2. **`panel` 不再匹配左栏冒充「面板」** —— 要么拆成两条，要么改名。
3. **`compare.mjs` 对 `measured` 至少有一条判据**，且该判据在变异下会红（见 §五）。
4. **`run.sh` 仍然 `EXIT=0`**（T141 修好的门禁不能被打回去）。
5. **`unregistered` 仍是 0** —— 新增判据不能靠「把差异登记成已知」来变绿。

## 五、变异（必须做，每条先写预期）

| # | 变异 | 预期红 | 为什么是这条 |
|---|---|---|---|
| M1 | 删掉 `aside` 选择器 | 1（§四.1 那 9 格） | 证明「右栏被量到」这条是活的 |
| M2 | 把某个 `aside-row` 的 `text-caption` 改成 `text-[13px]` | 1（字号不在七档） | 模拟 T142 漏改一处 |
| M3 | 把某个右栏卡片的 `rounded-[var(--radius-panel)]` 改成裸 `rounded-md` | 1（圆角不在 token 集） | 模拟「值对了但没走 token」 |
| M4 | **只让 `git-pane` 的 `aside` 量不到**，其他三个正常 | **1**（不是 4） | 证明判据按场景定位，不是「有任意一个就算过」 |

**⚠️ M4 是本卡的重点。** 如果判据写成「至少有一个场景量到了右栏」，
它会绿着放过 `git-pane` 的缺失 —— 而那正是「某个面板没渲染」的形状。

**M1 与 M4 的区别**：M1 验「判据存在」，M4 验「判据按格定位」。
**两条都要，缺一条就有一类回归会漏。**

## 六、边界

**可以改**：
- `apps/desktop/scripts/arc005-visual-baseline/probe-assertions.ts`（`ARC005_MEASURE_SELECTORS`）
- `apps/desktop/scripts/arc005-visual-baseline/compare.mjs`
- `apps/desktop/scripts/arc005-visual-baseline/README.md`
- 新建套件（如果需要独立的 `measured` 比对器）

**不许碰**：
- `probe.ts` 的 `SCREENS` / 场景分派 / `KNOWN_UNCAPTURED`（T141 刚定稿）
- `apps/desktop/src/renderer/` 下的**任何组件**（本卡只改测量与判据，不改界面）
- `styles.css` / `tailwind.config.js`

**开工前必须做**：

```bash
git status --porcelain
ls -l --time-style=+%H:%M apps/desktop/scripts/arc005-visual-baseline/*.ts
```

`probe.ts` / `probe-assertions.ts` 若在最近几分钟内被改过，**先等**（T142 正在迁字号）。

## 七、Required Skills

- `mcode-smoke` —— 本卡改的是 smoke 套件自身，需要它那套「变异验证」的做法。
- `verification-before-completion` —— 本卡的判据很容易写成「绿着但什么都没看」，需要它那套「先跑验证再说完成」。

## 八、回写

1. `panel` 那条最后怎么处理的（拆 / 改名 / 删），为什么。
2. 加了哪几个测量选择器，各自在 9 格里 `present` 的实测结果（**表格，逐格**）。
3. `compare.mjs` 对 `measured` 加了哪几条判据，各读什么来源（token 集合从哪来）。
4. 四条变异的实测红数与「红的对不对」（M4 必须单独说）。
5. `run.sh` 的退出码、`unregistered` 数、JSON 各计数的前后对比。
6. 你觉得不对但没改的。

**⚠️ 第 2 条是硬要求**：**逐格列**，不是「都通过了」。
`CLAUDE.md` 的教训是「判据的名字可以比它检查的范围大」——
**你说「9 格都 present」时，必须能指着那张表**。
