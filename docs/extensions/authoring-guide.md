# 写一个 Mcode 扩展

> **这份文档回答两件事：我能装什么、怎么写一个装得进去的。**
>
> Mcode 有**两条**扩展路径，它们不是一回事：
>
> | 路径 | 装什么 | 成熟度 |
> |---|---|---|
> | **Mcode 原生扩展** | 你手写的 JSON 清单 | ✅ **完整**，本文档 §1–§5 讲这个 |
> | **VS Code 扩展（`.vsix`）** | 从市场下载的扩展包 | ⚠️ **只支持一小类**，见 §6 |

---

## 0. 先说清楚边界（读这一节能省你半小时）

| 你想做的 | 支持吗 | 走哪条 |
|---|---|---|
| 写一个声明式扩展，调用宿主已有的只读能力 | ✅ **完整支持** | 原生（§1 形状 A） |
| 写一个带 `program` 的扩展，在受控子进程里跑自己的 JS | ✅ **完整支持** | 原生（§1 形状 B） |
| 装一个结构简单的 `.vsix`（单文件、≤24 KiB、只依赖 `vscode`/`path`） | ⚠️ **能装，但多数会失败** | VSIX（§6） |
| 装 `rainbow-csv` / `python` / `powershell` 这类真实市场扩展 | ❌ **不行** | 见 §6 的「为什么」 |
| 让扩展 `require` npm 包 / 联网 / 渲染任意网页 | ❌ **不支持** | — |

⚠️ **别用「能不能装 `.vsix`」来判断能力。** 能装 ≠ 能跑：
一个装进来的 VSIX 很可能在激活时崩掉（缺 `os`、缺相对路径模块）。
**判定标准是「它能不能跑起来」，不是「它出现在列表里」。**

---

## 1. 两个能跑的形状（原生扩展）

### 形状 A：纯声明式（不需要写代码）

清单里引用的 `capability` 是**宿主内置能力**（如 `core.file.stat`）。
Mcode 自己去调，你的扩展只负责「说什么、显示在哪个菜单、展示哪几个字段」。

**适合**：给某类文件加一个菜单项，把已有的数据重新组织一下展示。

### 形状 B：带 `program`

清单里引用的 `capability` 是 **`module.<短名>`**，同时在 `program.source` 里给出一个工厂函数。
Mcode 会把它放进**受控子进程**里跑。

**适合**：你真的需要自己算点什么（读文件内容、做转换、算统计）。

**两条硬约束**（`ModuleManifestSchema` 在形状层就拒，不会装到一半才失败）：

1. 引用了 `module.*` 能力 → **必须**有 `program`；
2. 有 `program` → **必须**至少引用一个 `module.*` 能力（否则装下一段永不执行的代码）。

---

## 2. 从零写一个（形状 B，真能跑）

这个例子和仓库里的预设 `apps/desktop/resources/presets/extensions/line-counter.json` 同形。

```json
{
  "apiVersion": 1,
  "id": "user.line-counter",
  "version": "1.0.0",
  "title": { "zh": "统计行数", "en": "line-counter" },
  "permissions": ["files.read"],
  "contributions": [
    {
      "id": "count",
      "slot": "files.context",
      "title": { "zh": "统计行数", "en": "统计行数" },
      "extensions": [".txt", ".md", ".ts", ".js"],
      "capability": "module.count",
      "view": {
        "title": { "zh": "统计行数", "en": "统计行数" },
        "fields": [{ "key": "lines", "title": { "zh": "lines", "en": "lines" } }]
      }
    }
  ],
  "program": {
    "source": "({ count: async (resource) => ({ lines: require(\"node:fs\").readFileSync(resource.path, \"utf8\").split(\"\\n\").length }) })",
    "timeoutMs": 10000
  }
}
```

### 每个字段

| 字段 | 约束 | 说明 |
|---|---|---|
| `apiVersion` | 字面量 `1` | 版本化入口 |
| `id` | `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$`，3–100 字符 | **必须含 `.` 或 `-`**（单个词不行）。`user.` 前缀 = 用户扩展 |
| `version` | `^\d+\.\d+\.\d+$` | 语义化版本 |
| `title` | `{ zh, en }`，各 1–120 字符 | **两个都要给**，缺一个不合法 |
| `permissions` | 至少 1 项，取自权限枚举（见 §3） | 只是「请求」，真正执行仍要宿主授权 |
| `contributions` | 1–12 项 | 见下表 |
| `program` | 可选 | `source` ≤ 64 KiB；`timeoutMs` 100–60000，缺省 15000 |
| `program.source` | **一个表达式**，求值结果必须是 `{ 短名: async 函数 }` | 不是模块体，是**表达式** |
| `program.source` 里的函数签名 | `async (resource) => ModuleResult` | `resource` 有 `path` / `projectPath` |

**`slot` 的四种取值**：

| slot | 出现在 | 额外必填 |
|---|---|---|
| `files.context` | 文件右键菜单 | `view`（`title` + `fields`） |
| `command` | 命令面板 | `command`（`^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9.-]{1,80}$`），可选 `icon` |
| `view` | 左/右/底部面板 | `location`（`right`/`left`/`bottom`）+ `view` |
| `settings` | 设置页 | `properties`（1–30 条，key 唯一） |

**`view.fields` 的 `key`**：`^[a-zA-Z][a-zA-Z0-9]*$`，1–20 个字段。
**`title` 一律要 `{ zh, en }` 双份。**

---

## 3. 权限模型

权限名是**闭集**，定义在 `packages/contracts/src/appPermission.ts`（由脚本生成，别手改）。

常见几档：

| 权限 | 含义 | 备注 |
|---|---|---|
| `resource.read` | 读你**选中**的那个文件 | 最常需要 |
| `resource.write` | 写你选中的那个文件 | 逐次批准 |
| `files.read` / `files.write` | 工作区文件读写 | |
| `network` | 允许出网 | ⚠️ 很多 Windows 环境**直接装不了**（见下） |
| `code.execute` | 执行代码 | 高风险 |

**三条要知道的规则**：

1. **写上权限 ≠ 拿到权限。** 清单里的 `permissions` 是**请求**，安装时用户在卡片上逐项勾选，
   真正生效的是**授予的那个子集**。
2. **`action` 类能力每次执行都要批准。** 只读 `query` 不需要。
3. **没授权通道 = 一律拒**（fail-closed）。不是「默认放行」。

⚠️ **`network` 在部分 Windows 环境装不了。** 那些环境没有 AppContainer/WFP 出站沙箱，
Mcode 会要求用户先明确接受「仅 JS 守卫」的降级；**声明 `network` 的扩展在该平台仍会被拒**。
这条写进了 UI 文案 `ide.modules.egressWarning`。

---

## 4. 装进去，以及装失败时看哪

**入口**：设置 → **UI 扩展**（`ide.modules.title`）→ 粘贴清单 JSON → 「确认并导入 / 更新」。

**安装会经过一张卡片**（三态：允许一次 / 始终允许 / 拒绝）。
**拒绝 = 磁盘上没有任何写入**（`deny` 在宿主里先于任何写盘抛出）。

### 装失败时

| 症状 | 在哪看 |
|---|---|
| 清单结构不合法 | 面板实时校验（`ModuleSurface.tsx:38` 的 `ModuleManifestSchema.parse`），错在哪个字段会指出来 |
| 「扩展权限必须持久化，当前宿主没有授权写入通道」 | 宿主没接权限存储 —— 生产环境不会出现，只在你自建宿主时 |
| 「安装失败且权限回滚失败」 | 上一条的连带错误，说明回滚也失败了；看主进程日志 |
| 装了但菜单里没出现 | 检查 `extensions` 数组是否包含那个文件后缀（**必须带点**，如 `.md`） |
| 装了但调用失败 | 带 `program` 的要在**受控子进程**里跑；Windows 上会先要求 egress 授权（见 §3） |

**调试捷径**：仓库里有 `apps/desktop/scripts/extension-authoring-smoke/`，
它用真 `ModuleHost` + 假 verifyProgram 跑安装与校验 —— 你想验证一个清单，照它写一个探针最快。

---

## 5. 一个真的装得进去的证据

不是「我觉得能装」。下面这段是实跑 `ModuleHost.install` 的结果：

```text
schema: OK
install: {"catalog":{"modules":[{"id":"user.line-counter",...,
  "capabilities":[{"id":"module.line-counter.count","kind":"query"}],
  "modulePermissions":{"user.line-counter":{"granted":["files.read"],
    "duration":"session"}}}],"cancelledTasks":0,"cancelFailures":[]}}
catalog.modules ids: [ 'user.line-counter' ]
```

**关键点**：清单里写的是短名 `module.count`，宿主分配出的是 **`module.line-counter.count`**
（`module.<模块 slug>.<短名>`）。**你不能引用别的模块的 `module.*`** —— 你自己的分配集合里没有它。

---

## 6. VS Code 扩展（`.vsix`）：能装一小类，多数跑不起来

### 入口在哪

设置 → **UI 扩展** → 「从 .vsix 安装」。
IPC 是 `modules.installVsix`（契约 `ModuleInstallVsixSchema`），走和原生扩展**同一套审批**
（三态卡片：允许一次 / 始终允许 / 拒绝；**拒绝时不读文件、不写盘**）。

### 现在的限制（实测数字，不是估计）

| 限制 | 现值 | 真实扩展的典型值 |
|---|---|---|
| 包内文件数 | **恰好 2 个**（`package.json` + 声明的 `main`） | 6–20 个 |
| 整包大小 | **128 KiB**（压缩后） | 秒到几 MB |
| `main` 源码 | **24 KiB** | `rainbow-csv` 是 136 KB |
| 命令数 | 256（清单能收，但**运行时只跑第 1 条**注册的） | 24–101 |
| `require` 白名单 | `vscode` / `path` / 受限 `fs` | 常含 `os`、相对路径、`child_process` |

### 哪些能装、哪些不能（本机 24 个真实扩展实测）

| 能装（12 个） | 不能装（12 个） |
|---|---|
| `latex-workshop`（22 KB，只依赖 `vscode`+`path`） | `rainbow-csv`（136 KB） |
| `pdf-translate`（7 KB） | `python` / `powershell`（2 MB+） |
| 9 个 `ms-azuretools.*`（1 KB） | `remote-ssh` / `remote-wsl`（1 MB+） |

⚠️ **「能装」不等于「能跑」**：那 9 个 Azure 扩展的 `main` 只有 1 KB 是因为**真正干活的代码在别的文件**，
它们会因相对路径 `require` 被拒而崩掉。**真正能跑的只有 `latex-workshop` / `pdf-translate` 这一类。**

### 为什么不能简单放宽

**`rainbow-csv` 在模块顶层 require `child_process`**（`extension.js:6`）。
放行它 = 扩展能在你机器上跑任意命令，**和「扩展只能读写你本次选中的那个文件」直接冲突**。

所以问题不是「限额差一点」，是**执行模型不匹配**：

> Mcode 的执行模型是「**一段自包含的源码 + 一个能力名**」，
> 而 `rainbow-csv` 是**一个 6 文件的 Node 程序**。

要真跑这类扩展，需要：多文件解包 + CommonJS 模块加载器 + 依赖解析 + 完整 `vscode.*` API 面，
**并且必须先决定 `child_process` 放不放**。那是一件独立的大事，不是调阈值。

### 装失败时怎么读错误

拒绝分两类，`code` 不同、**用户下一步动作也不同**：

| `code` | 含义 | 你能做什么 |
|---|---|---|
| `VSIX_REJECT_TOO_LARGE` | 尺寸超了 | 找更小的版本 |
| `VSIX_REJECT_STRUCTURE` | 结构不支持（文件数、依赖形态） | **什么都做不了，别试了** |
| `VSIX_REJECT_INVALID` | 包坏了（CRC 不符、清单非法） | 重新下载 |

**如果错误里写着「The archive contents were not inspected」** —— 那是整包就超限、
连解压都没做，所以**它 require 了什么我们根本不知道**。别把这句话读成「只有尺寸问题」。

---

## 7. 明确不支持的东西（两条路径都适用）

| 不支持 | 为什么 |
|---|---|
| 装 npm 依赖 | 清单里没有依赖字段，宿主也不 `npm install`；`program.source` 是**一段自包含的表达式** |
| 联网 | `permissionedProcessRunner` 在**运行时**把 `http/https/http2/net/tls/dgram/dns` 的出站 API 全替换成拒绝（含 `Agent.prototype.createConnection` / `new net.Socket().connect` 这些绕过路径）。这是运行时守卫，不是 require 白名单 —— **代码能 require，但调不通** |
| 渲染任意 HTML / 网页 | `customUi` 是另一套受控机制，不是模块清单 |
| 引用别的模块的 `module.*` 能力 | 宿主按模块分配，跨模块不可见 |
| `module.a.b` 这种多段短名 | 会在重装/重启时被二次分配，schema 层就拒 |
| VSIX 里的 `child_process` / `os` / 相对路径 require | 见 §6「为什么不能简单放宽」 |

---

## 8. 想改这份文档？

改之前先跑：

```bash
cd apps/desktop && bash scripts/extension-honesty-smoke/run.sh
```

那套会验「文档说的和代码做的是不是一回事」——包括本文档里的清单 JSON 能不能被
`ModuleManifestSchema` 解析通过。**改了示例却忘了更新，那套会红。**

⚠️ **必须先进 `apps/desktop`**：`run.sh` 里的路径是相对**当前目录**的。
从仓库根直接 `bash apps/desktop/scripts/.../run.sh` 会报
`lib/esbuild-path.sh: No such file or directory` —— 而 `rc` 是 127，
**输出只有一行，看起来像「套件没红」而不是「套件没跑」**。

⚠️ **本文档曾经整节说「`.vsix` 没有安装入口」，而在它写完之后那个入口已经做出来了**
（F006，`901e58ee`）。**改了行为就回头改这一节** —— 一份说「没有 X」的文档，
比一份什么都不说的文档更坏，因为读者会据此放弃。

⚠️ **本文档第 7 节原来写的是 `node apps/desktop/scripts/.../run.sh`** ——
`run.sh` 是 bash 脚本，`node` 跑它只会 `ERR_UNKNOWN_FILE_EXTENSION`。
**这条命令从写下来那天起就没能跑过。**
