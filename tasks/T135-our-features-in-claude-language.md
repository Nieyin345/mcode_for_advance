# T135｜我们独有的功能，也该用 Claude 的视觉语言

- Status: ready-for-agent
- Category: **P0 产品主线（UI）—— 用户说「模仿完之后再加我的新功能」**
- Priority: **P0**
- Depends on: T121（十项规范已落地）、T128（hover/selected 已对齐）、T133/T134（字号/宽度已对齐）

## ⚠️ 这张卡解决什么矛盾

**用户的指令有两条，看起来冲突：**

1. 「**ui 就是全盘模仿 claude**」
2. 「模仿完之后我们再加**我的新的 ui 功能**……比如文件系统」

**而 Mcode 比 Claude 多出这些：**

| 目录 | 我们独有的组件 |
|---|---|
| `ide/` | 文件树、Git 面板、回合流程、任务列表、Office 编辑器宿主 |
| `chat/` | 任务中心、工作流看板、资料库选择器、文件提及、选区引用菜单 |
| `layout/` | 独立右栏、三栏布局、底部终端 |

**这些在 Claude 里不存在** —— 所以「照抄」没有对象。

**真正的做法是**：让这些功能**用 Claude 的视觉语言呈现**（层次、圆角、字号、状态表达），而不是让它们保持自己的一套。

## 一、现状：它们长着自己的样子

**证据：视觉基线覆盖 12 个场景，但没有一个是右栏的。**

```
approval / diff / editor / empty / messages / narrow-window
parallel / preview / projects / settings / terminal / tools
```

**`sidechat` 那三格是 `data-missing`。**

**所以「我们独有的功能长什么样」从来没有被记录过，也没有被比对过。**

## 二、任务

### 一、先扩展视觉基线，覆盖那些场景

**在 `arc005-visual-baseline` 里加这几格**（这会成为后续所有改动的判据）：

| 新格 | 拍什么 |
|---|---|
| `files-pane-light/dark-1280` | 右栏文件树展开 2 层 |
| `git-pane-light/dark-1280` | Git 面板有几个改动的文件 |
| `taskcenter-light/dark-1280` | 任务中心有 3 个任务（1 个 failed） |
| `workflow-light/dark-1280` | 工作流看板 |
| `office-host-light/dark-1280` | Office 编辑器宿主（用桩，不开真文档） |

**⚠️ 这会改 `arc005-visual-baseline/`，那是共享套件。** 所以：
- **新增格是加法**，不改已有的 39 格；
- **不要为了方便而改已有格的判据**；
- 每一格都要有 `api-stub.js` 的对应数据（**不碰用户真实数据**）。

### 二、然后逐块对齐

| 块 | 该对齐什么 |
|---|---|
| **文件树** | 行高（Claude 侧栏是 28–32px）、hover 用 `cds-hover-ghost`、选中用 `--selected-bg` + 品牌色字 |
| **Git 面板** | 同上 + 状态徽标用 `text-caption`、颜色用 `--success` / `--danger` |
| **任务中心** | 卡片用 `bg-surface-raised` + `--shadow-card`、标题用 `text-heading` |
| **工作流看板** | 节点卡片同任务中心 |
| **Office 宿主** | 工具栏和 Claude 的 artifacts 工具栏一致（高度、图标尺寸、按钮 hover） |

**⚠️ 不要一次全改。** 按块做，每块独立提交，每块跑扩展后的视觉基线。

## 三、判据

1. **视觉基线新增 5 个场景**（10 格：亮暗各一），且能拍出内容（不是 `data-missing`）。
2. **每一块对齐后，差异可对照**（compare.mjs 报出改了什么）。
3. **不回归已有的 39 格**。
4. **不碰用户数据**（`api-stub.js` 提供虚构数据）。

## 四、⚠️ 一个必须回答的问题

**「用 Claude 的视觉语言」具体指什么？**

从已落地的八项里提取：

| 维度 | Claude 的做法 | 我们该照做的 |
|---|---|---|
| **正文** | 14px / 20px 行高 | `text-body` |
| **次要信息** | 11px / 12px | `text-caption` / `text-footnote` |
| **标题** | 16px / 20px | `text-heading` |
| **层次** | 4 层 Surface | `bg-surface` / `-muted` / `-raised` / `-overlay` |
| **边框** | 细、淡 | `--edge`（14%） |
| **圆角** | 12px（卡片）/ 16px（弹窗） | `--radius-card` / `--radius-dialog` |
| **悬停** | 可复用类 | `.cds-hover-ghost` |
| **选中** | 10% 灰底 + 品牌色字 + medium | `--selected-bg` / `--selected-content` |

**所以「对齐」不是重新设计，是用这 8 个既有的工具。**

**如果某个地方这 8 个工具都不适用，那就是真的需要新设计** —— 那时候才停下来讨论。

## 五、边界

**可以改**：
- `apps/desktop/scripts/arc005-visual-baseline/`（**只加场景，不改已有判据**）
- `components/ide/`、`components/layout/RightPanel.tsx`、`components/chat/TaskCenterPanel.tsx` 等**我们独有的组件**
- 套件

**不许碰**：
- `styles.css` 的 token 定义（已稳定）
- `tailwind.config.js`
- `chat/` 里 Claude 也有的组件（`MessageRow` / `ComposerEditor` / `ChatPane` 已对齐）

## 六、回写

1. **视觉基线新增了哪几格、能不能拍出内容**
2. 每块对齐时用了哪几个工具（8 个里的哪几个）
3. **有没有哪一处 8 个工具都不适用**（那是真需要新设计的）
4. 差异对照（改前 / 改后）
5. 套件数字、提交 SHA
