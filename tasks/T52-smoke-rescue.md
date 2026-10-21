# T52｜smoke 急救：501 套里 25 套红，其中 15 套是构建就崩

| 项目 | 值 |
|---|---|
| 编号 | T52 |
| 类型 | **测试基础设施**（不是新功能，是让验证重新可信） |
| 优先级 | **最高** —— 25 块地方的验证是假的 |
| 建议并发 | 改 `apps/desktop/scripts/` + `electron.vite.config.ts`；与功能卡不撞 |
| 预计规模 | 中 |

---

## 实测现状（2026-10-21，`bash apps/desktop/scripts/run-all-smokes.sh`）

**501 套，25 套红。** 分两类，根因完全不同。

### A 类：15 套在 esbuild 构建期就崩（不是断言失败）

```
X [ERROR] Top-level return cannot be used inside an ECMAScript module

    ../../genoffice/packages/html2docx/src/browser/core/paragraphs-document.js?raw:285:2:
      285 │   return globalThis.__html2docxPages.build({
          ╵   ~~~~~~
```

**根因**：T28 把 GenOffice 的 vendor 包引入了主进程 bundle。其中
`html2docx` 有一个用 `?raw` 导入的文件，那个文件顶层有 `return`，
esbuild 在 ESM 上下文里拒绝它。

**受影响的套件**（实测 15 个，含）：
`agent-mail` / `app-control` / `base-capability-matrix` / `document-read` /
`effective-tools` / `genoffice-cli` / `genoffice-format-gates` /
`genoffice-editors-release` / `genoffice-mcp` / `ipc-wiring` /
`html-preview-electron` / `maint-m15` / `mcode-admin` / `mcp-endpoint` / `mcp-ui`

**关键**：这些套件的**产品代码可能是对的**，但它们的 bundle 现在装不下 vendor。
**这不是「测试坏了」，是「测试再也跑不起来了」。**

### B 类：10 套是真断言失败或被信号打断

| 套件 | 现象 | 判断 |
|---|---|---|
| `arc005-chrome-polish-smoke` | 11/12，1 条断言红 | **真失败** |
| `design-tokens-smoke` | 338/339，1 条断言红 | **真失败** |
| `skills-management-ui-smoke` | 需单独看 | 待定 |
| `lsp-smoke` | 内部断言全 `ok`，但 exit=3840 | **像并发撞车** |
| `automation-smoke` | exit=3840 | 同上 |
| `mcode-node-pack-smoke` | exit=3840 | 同上 |
| `market-multiprocess-smoke` | exit=3840 | 同上 |
| `mcp-ipc-smoke` | exit=3840 | 同上 |
| `mcp-market-boundary-smoke` | exit=143（SIGTERM） | 同上 |

**`3840 = 15 × 256`** —— 不是正常退出码，像是被外部或运行器 kill 掉。
`143 = 128 + 15`（SIGTERM）。这两组要单独诊断。

---

## 为什么这张卡优先

`docs/testing.md` 与 `tasks/README.md` 都写着「test:all 0 失败是基线」。
**现在基线是 25 红，而且这个事实被记成了「test:all 当前仍是红的，不能声称全绿」。**

后果是真实的：任何一张卡说「现有套件全绿」，那 25 套里的验证都是空的。

**修好它，比再加一个新功能更重要。**

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/.claude/skills/mcode-smoke/SKILL.md` —— **全文**，尤其是
   「`--alias` 只认包名」「相对 import 换不掉」「`--banner` 非有不可」。
3. `apps/desktop/scripts/run-smokes.mjs` 的 `runPool` / `runSuites`：
   - `:253` 默认并发 `min(6, cores)`
   - `:254` 重型套件 `min(3, ceil(cores/4))`
   - `:232` 超时 `240_000`
4. `apps/desktop/electron.vite.config.ts` —— T28 新增的 vendor 别名。
5. `genoffice/packages/html2docx/package.json` 与
   `src/browser/core/paragraphs-document.js`。
6. `CLAUDE.md` 的环境事实：**这台机器反复蓝屏 0x1A**。

---

## 执行内容

### 第 1 步：修 A 类（15 套构建失败）—— 这是最急的

**根因排查**：

- 为什么 `agent-mail-smoke` 这样的**主进程**套件会 import 到 `html2docx`？
  （T28 新增的 vendor 别名把整条 import 链带进来了）
- `html2docx` 那个 `?raw` 导入是给谁的？是渲染端用的还是主进程用的？
- 有没有办法**只对需要它的套件**加载？

**可能的修法**（按优先级）：

1. **精确别名**：只把真正需要的子路径映射到 vendor，
   不要把整个 `html2docx` 包根映射进去（照 `slidesVendorModules` 的做法）
2. **`--loader:.js=text`**：如果那个文件确实只当字符串用，
   在 esbuild 参数里加 loader
3. **stub**：如果那些套件根本不需要 `html2docx`，加一个 stub 别名

**判据**：15 套全部能跑到断言阶段（红绿都行，但不再构建失败）。

### 第 2 步：修 B 类的 3840 / 143

**先确认是不是并发撞车。**

```bash
# 单跑，看是否绿
MCODE_SMOKE_JOBS=1 bash apps/desktop/scripts/run-smokes.mjs lsp-smoke automation-smoke \
  mcode-node-pack-smoke market-multiprocess-smoke mcp-ipc-smoke mcp-market-boundary-smoke
```

- **单跑绿** → 是并发问题。改 `run-smokes.mjs` 的默认并发，
  或给这些套件标「重型」
- **单跑也红** → 是真失败，进第 3 步

**注意**：`CLAUDE.md` 写了本机蓝屏风险，降并发是**正确的方向**，
不是「掩盖问题」。

### 第 3 步：修 B 类的两条真断言失败

- `arc005-chrome-polish-smoke` 的那条：
  「工作区信息有弹性、可剪裁的单个上下文条且主窗口不重建」
- `design-tokens-smoke` 的那条（要单独看日志确认是哪条）

**这两条不要盲目改断言。** 先判断：
- 如果是产品代码真的退化 → 修产品
- 如果是断言过时 → 修断言，并在回写区说明为什么

### 第 4 步：把「test:all 是红的」这个事实写进基线

修完之后：
- `docs/testing.md` 更新基线
- `tasks/README.md` 的「已知未修」段清空这一条

### 第 5 步：给 `run-all-smokes.sh` 加一个「快速失败」摘要

现在跑全量要几分钟，输出 501 行。加一个 `--failures-only` 之类的开关，
只打印失败套件与失败的断言行。

**这不是必需的，但如果顺手就做。**

---

## 边界（不要碰）

- **不改产品代码**，除非第 3 步确认是真退化。
- 不改现有断言的语义（可以改形状让它匹配新实现，删断言不行）。
- 不改 vendor 源码（`genoffice/`）。
- 不改其它卡的领域（`document/` / `workflowEngines/` / `appControl/`）。

---

## 验收判据

1. `bash apps/desktop/scripts/run-all-smokes.sh` → **501 套全部跑到断言阶段**
   （不再有构建失败）。
2. 失败套件数从 25 降到 **0 或可在回写区逐一解释的极小数目**。
3. 每一条修掉的失败都有「根因 + 修法」记录在回写区。
4. 6 套疑似并发的套件：单跑结果写进回写区。
5. 双包 tsc 干净。
6. **变异验证**：A 类的修法要证明「撤掉修复 → 该套件重新构建失败」；
   B 类如果是产品退化，撤掉修复 → 断言红。

---

## 回写区要回答

- 15 套构建失败的根因是**同一个**吗？有没有不止一个原因？
- `html2docx` 的 `?raw` 文件到底是谁在用？主进程真的需要它吗？
- 6 套 3840 的套件，单跑绿不绿？并发的安全上限是多少？
- `arc005-chrome-polish` 与 `design-tokens` 那两条，是产品退化还是断言过时？
- 修完之后 `test:all` 的耗时是多少？降并发后变慢了多少？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
