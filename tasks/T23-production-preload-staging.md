# T23｜生产构建与发行 staging 缺四个编辑器的 preload —— 安装包里四个编辑器是坏的

- Status: ready-for-agent
- Category: bug
- Priority: **P0 发行阻断**
- Depends on: none
- Exclusive writable files: `apps/desktop/electron.vite.config.ts`、`apps/desktop/build/stage-genoffice-resources.cjs`、相关构建校验脚本、新建回归套件。**不改** `genoffice/` 上游、`patches/`。

## Required Skills
- `code-review`: 确认修复覆盖生产构建与发行 staging 两条路径，而不只是让测试变绿。
- `mcode-smoke`: 给「生产产物里真有这些文件」建断言，而不是给「测试自己能打包」建断言。

Read before work: `CLAUDE.md`、`docs/planning/product-roadmap/T13-genoffice-baseline.md`（**§0.4 与 §11 必读**）、`apps/desktop/electron.vite.config.ts`、`apps/desktop/build/stage-genoffice-resources.cjs`、`apps/desktop/scripts/arc005-visual-baseline/README.md`。

## T13 已核实的事实（我已独立复验，不要重新发现）

### 缺口一：生产构建不产出 Docs 的 preload

```
grep -n "documentViewPreload" apps/desktop/electron.vite.config.ts
→ 零命中（22 个历史版本也零命中）
```

四个真 Electron 套件（`document-view-*`）各自把 `documentViewPreload` **打包到自己的探针临时目录**，所以它们能绿。**生产构建从来不产出 `out/main/documentViewPreload.js`。**

### 缺口二：发行 staging 只复制两个编辑器的 preload

```js
// stage-genoffice-resources.cjs:434
const nativePreloads = ["sheets", "slides"].map(name => ({
  name, preload: join(vendor, "apps", name, "out", "preload"),
}));
```

而 `EDITOR_APPS` 是**六个**（docs/sheets/slides/pdf/markdown/html）。

**后果**：安装包里 PDF、Markdown、HTML 三个编辑器的原生视图必然 `status=false` 降级。

### 缺口三：vendor 产物旧于补丁 0013

`ai:tool-result` 在 Docs 的 vendor `out/` 产物里 **0 命中**，说明 vendor 构建产物早于补丁 0013。T0 的接线即使代码正确，安装包里也不会生效。

## 为什么这是 P0

**六个编辑器里四个在真实安装包中是坏的，而现有测试全绿。**

绿的机制是「测试自己发包，绕过生产构建与 staging」。这和 CLAUDE.md 警告的假绿是同一类：套件跑绿但根本没覆盖到真实路径。

用户装上这个包，打开 PDF/Markdown/HTML 会降级；Docs 的原生视图根本不工作。

## 目标

三处缺口**全部**修掉，并且证明修的是生产路径。

### 缺口一：生产构建

- 在 `electron.vite.config.ts` 里为 `documentViewPreload` 增加构建入口，产出到生产位置。
- 在 T13 报告所述的四个 `document-view-*` 套件里，**改为消费生产构建产物**（或至少增加一条断言：生产配置声明的入口存在且产物路径与套件使用的一致）。
- 断言方式不限，但**必须证明「生产构建跑完后这个文件真的存在」**，不是「套件自己打包了它」。

### 缺口二：发行 staging

- `nativePreloads` 从 `["sheets","slides"]` 扩到六个编辑器实际需要的集合。
- **先核实**六个编辑器各自是否真的有 `out/preload` 产物；有的必须 stage，没有的要说明为什么不需要（例如 docs 走 Mcode 自己的 preload）。
- staging 的完整性校验要按**实际存在的** preload 集合断言，不能硬编码两个名字。

### 缺口三：vendor 产物陈旧

- 核实 vendor `out/` 的构建时间与补丁 0013 的关系。
- 如果确实陈旧：说明重建流程，并在 staging 时**校验产物包含补丁 0013 的标记**（例如 `ai:tool-result` 出现在预期产物里），不含就 fail-closed。

## 验收判据

1. 跑一次生产构建，**断言 `out/main/documentViewPreload.js` 存在**。
2. 跑 staging，**断言六个编辑器各自需要的 preload 都在安装包布局里**；缺任何一个就失败。
3. 三个 `document-view-*` 类套件不再依赖「自己打包那一个文件」——或至少新增一条断言把生产配置与套件输入绑在一起。
4. 若 vendor 产物陈旧：staging 能检测到并明确报错，而不是静默出一个坏包。
5. **变异验证**：把缺口二改回只 stage 两个 → 第 2 条必须变红；逐字节还原（`cmp`）。
6. 双包 typecheck 通过。
7. **不得**宣称 T7（六编辑器 U1）完成——本卡只修构建与发行链，真实 Electron U1 是 T7。

## 边界

- **不改** `genoffice/` 上游源码、`patches/genoffice/`。若必须重建 vendor 产物，只在回写里记录命令与结果。
- **不碰**正在被 T0 修改的 `document/docsAiPorts.ts`、`document/nativeEditorToolTransport.ts`。
- 若发现修复需要改 `documentViewHost.ts`，先停下报告，另开卡。

## 结果回写（2026-10-23）

（执行者在此追加：三处缺口的修复点、生产构建与 staging 的实际产物清单、变异证据、提交 SHA、仍需 T7 覆盖的 U1 项）
