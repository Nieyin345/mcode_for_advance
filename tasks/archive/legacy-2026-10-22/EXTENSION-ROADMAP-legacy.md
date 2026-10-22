# 扩展系统路线图（总控维护）

> 用户目标原话：
> **「我想要的是这个扩展可以自己写，把mcode的能力都暴露出去，尽可能的贴近vscode，
> 然后，我可以让mcode里面的ai帮我写插件，明白吗，而且尽可能的自定义，
> 就是像vscode的扩展系统一个几乎无所不能」**
>
> 权限模型的形状（用户明确）：
> **「不是分级，就是装的时候会弹出来的卡片，要的权限，然后用户同意，
> 比如同意一次，比如始终同意，就像是手机的软件一样」**
>
> 风险范围（用户明确）：
> **「放进去呀，这个扩展也是基本能操作所有的软件内容，都要有接口」**

---

## 一、现状（实读，2026-10-21）

### 1.1 两套扩展系统，不是一套

| | `main/plugins/`（2,761 行） | `main/modules/`（2,576 行） |
|---|---|---|
| 是什么 | **Claude / Codex / zcode 插件生态** | **能跑任意 JS 的模块系统** |
| 能带什么 | skills / commands / agents / hooks / mcpServers / **nodeTypes** / capabilities | 清单 + 可执行程序 |
| 市场 | ✅ **已接三个真实市场** | ❌ |
| 执行 | 交给三引擎（skill / MCP） | 独立子进程 + `--permission` |
| 安全模型 | 装进来默认**禁用**，UI 审核后启用 | 执行前逐次审批 |

**插件系统已经很完整**，而且 `nodeTypes` 贡献点直接进工作流画布
（`~/.mcode/plugins/<名>/<版本>/node-types/`）。

### 1.2 模块系统的能力面几乎是空的

```ts
export const BUILTIN_CAPABILITY_CATALOGUE = [
  { id: "core.file.inspect", kind: "task",  source: "host" },  // 文件大小 + SHA-256
  { id: "core.file.info",    kind: "query", source: "host" },  // 字节数 + 修改时间
];
```

**两个能力，一个贡献点（`files.context`）。**

### 1.3 权限模型只有 3 个值

```ts
z.enum(["resource.read", "resource.write", "network"])
```

而 RPC 有 **438 个方法**，分 **40+ 个域**，五档判定
（`read` / `ui` / `write` / `danger` / `blocked`）。

**模块的权限模型和 RPC 的权限模型没打通。**

### 1.4 面板已经能调全部 RPC —— 但只有面板能

```ts
// renderer/components/customUi/panelBridge.ts:216
case "api.call": {
  const first = await api.customUi.panelApiCall({ method, input, panelLabel: label });
  // 主进程用 policy.ts 的五档判定；需要审批则弹卡
}
```

**这条通路走的是完整判定。** 但它只对**有面板 UI** 的扩展开放。
独立脚本（`ModuleHost`）调不到。

### 1.5 VS Code 兼容只到 L1-P

`docs/planning/extension-vscode-compat.md` 自己列的分级表：

| 级别 | 内容 |
|---|---|
| **L1-P**（有原型） | 一个命令、`registerCommand`、`executeCommand`、状态栏快照、`Disposable` |
| **L1-C** | `workspace.fs.readFile` |
| **L2** | `writeFile`、`showInformationMessage`、`getConfiguration`、`clipboard`、`withProgress`、诊断 |
| **L3**（明确不承诺） | **webview**、TreeDataProvider、menus/keybindings/themes、debug/tasks/terminal |

**Theia 拆不动**（19 个直接依赖，`plugin-vscode-init.ts` 只包装已有宿主）。

### 1.6 安装 UI 只有两个布尔值

```tsx
await api.modules.install({
  manifest,
  confirmReadAccess: true,                      // 恒为 true，不是勾的
  ...(manifest.program !== undefined ? { confirmExecutableCode: true } : {}),
});
```

---

## 二、复用什么、不复制什么

### ❌ 不复制 VS Code

- 300 万行 TypeScript，是一整个 Electron 应用
- Mcode 已经是另一个 Electron 应用，两个应用会打架
- **Monaco 已经在用了**（`monaco-editor@0.56.0`），编辑器内核已经有了

### ✅ 可以抄的

| 对象 | 怎么抄 |
|---|---|
| **VS Code 的主题 / 语法 JSON** | 纯数据，Monaco 直接加载。**Open VSX 上纯资源插件立刻能用** |
| **VS Code 的 Extension Host 形状** | Mcode 的 `ModuleHost` 已经是这个形状（子进程 + 注入 API），**照着补 API 数量** |
| **VS Code 的贡献点设计** | `commands` / `menus` / `views` / `configuration` 的设计值得对齐 |

### 本路线图的核心判断

**「让 Mcode 的 AI 写扩展」比「兼容 VS Code 插件」优先级更高。**

理由：
1. AI 写扩展 = 用户说一句话就有一个工具，**这是 Mcode 独有的优势**
2. 兼容 VS Code = 追一个不断变化的 200+ API，**永远追不完**
3. 前者做完，前者产出的扩展**就是 Mcode 原生扩展**，不需要兼容层

---

## 三、四张卡

| 卡 | 内容 | 前置 |
|---|---|---|
| **T48** | **权限模型**：安装时一次性授权，438 个 RPC 全部可授权 | 无 —— **可立即派** |
| **T49** | **调用面**：把 438 个 RPC 暴露给扩展（`core.app.call`） | T48 |
| **T50** | **UI 贡献点**：命令 / 侧栏面板 / 设置项 | T48 |
| **T51** | **让 AI 会写扩展**：文档 + 校验工具 + 模板 + 闭环 | T48、T49 |

### T48 的核心

把权限从 3 个值扩成**按能力域分组的清单**（约 25 个），
建立 `方法名 → 权限` 的映射（438 个方法全覆盖），
安装 UI 变成权限勾选页，运行时查授权表而不是逐次弹卡。

**`blocked` 的那批仍然不给**（「替用户批准」/「返回凭据本体」——结构性不可委托）。

### T49 的核心

**不造新通路，复用已有的。**

`core.app.call` 能力 → 经双向 NDJSON 子进程通道 → 复用 `invokeAppTool`
→ 走 T48 的授权表 + `policy.ts` 的判定。

**这是仓库硬规矩 2 的直接应用。**

### T51 的核心

AI 现在能做的：读文档、查 API、调 API、写文件。
**不能做的：验证写完的扩展对不对。**

加 `extension_validate` 工具（不落盘、不安装，只报告），
加 `app_guide { topic: "extensions" }` 文档，加 3 个能跑的模板。

---

## 四、不做的

| 不做 | 为什么 |
|---|---|
| `webview` 贡献点 | Mcode 已有 `customUi`（沙箱 iframe + `mcode.api.call`），复用即可，另开卡 |
| `languages` / `themes` / `keybindings` / `statusBar` | 各自独立，后续单开 |
| 真实 VSIX 格式（DEFLATE + 多文件） | 现在的 `readMinimalVsix` 只认两文件 STORE；升级它属于「装 Open VSX 插件」那条线，与「AI 写扩展」正交 |
| 复制 VS Code 源码 | 300 万行 + 两个 Electron 应用打架 |
| 接 Theia | 19 个直接依赖，拆不动 |

---

## 五、待验证的问题

1. **438 个方法能不能全部归到一个权限？** 有没有归不进去的？
2. **`blocked` 表里哪些是「不可委托」，哪些其实是「权限不够」？**
   用户说「都放进去」，但 `claude.approve` 这类授权了就是自己批自己。
3. **升级扩展时权限变化，用户怎么重新同意？** 每次都弹卡会烦，不弹卡会放宽。
4. **双向 NDJSON 通道会不会破坏现有的一次性协议？**
   `isolated_timeout` / `isolated_cancelled` 这些失败码还成立吗？
5. **真 AI 写扩展能一次成功吗？** 这是 T51 的最终判据。
