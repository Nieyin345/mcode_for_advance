# Mcode 结构性优化清单（对照 Claude Code 桌面端/引擎）

> **怎么来的**：用 REA 静态分析 `claude.exe`（2.1.276，235MB Bun 单文件，**内含明文可读 JS**，
> 已抽出 251 个模块到 `.tmp/cc-src/`），拿它的工具契约、agent loop、提示词组装、
> 会话持久化当镜子，照 mcode 自己的实现。
>
> **证据等级**：本文几乎全是 **E2**（源码调用链/静态读出）。**没有 E1**——没跑过对照实验，
> 没做过变异验证。凡数字都是 `grep`/脚本在**当前工作树**上数出来的，不是估算。
>
> **与 `Mcode_统一审查台账.md` 的关系**：台账那 75 条是**行为缺陷**（某个流程会错）。
> 本文补的是它**没覆盖的**一类：**结构性问题**——代码组织、职责边界、一致性的问题。
> 两者不重复，应当**并行维护**，不要合并编号。

---

## 零、先说 mcode 做得**比 Claude 好**的地方（不然下面全是批评，会误导）

这三条我实测过，是真实优势，不要为了"对齐 Claude"而改掉：

1. **Agent 自发现通道的覆盖率是 100%，而且是生成的。**
   `RpcMap` 402 个方法 → `appControl/apiCatalog.generated.ts` 403 条（多的一条是
   `skills.engines.set`，preload 侧面暴露）。**差集是 0，一个都没漏。**
   而这份目录是 `scripts/gen-app-api-catalog.mjs` 从 `rpcMap.ts` + `preload/index.ts`
   生成的（文件头明写"生成文件，别手改"）——**结构上不可能漂移**。
   对照 Claude：它的工具是手写 schema，靠人维护一致性。**这一条 mcode 明显更强，
   而且正是用户最高原则「AI 能完全控制 Mcode 的所有功能」的落地方式。**

2. **`BLOCKED` 档是按「原则」写的，不是按「名单」写的。**
   `appControl/policy.ts` 的每条 blocked 都带理由（"不能替用户批准工具调用（那等于自己批自己）"），
   并且**原则先于名单**——每次新增凭据型方法都触发一次判断，而不是等审计发现。
   这不是偶然：MC-004 记下的"判据不一致"被修成了现在的形态。

3. **零覆盖文件只有 3 个，且都是声明文件/桶文件。**
   `smokes-for.sh --uncovered` 报：`modules/moduleApproval.ts`、`claude-sdk/index.ts`、
   `raw-imports.d.ts`。**370 个主进程文件有回归网。** 这个密度很少见。

**下面每一条都对照这三条的标准来写**——够得上"结构性问题"才列。

---

## 一、【P0】渲染端 451 处散装调用，而 `sessionStore.ts` 是个 9371 行的上帝对象

### 问题在哪

| 事实 | 数字 |
|---|---|
| `await api.xxx()` 散装调用点 | **451** 处，分布在 **106** 个文件 |
| `useRpc`（硬规矩 7 要求的统一读口）使用点 | 75 处 |
| `sessionStore.ts` | **9371 行**，其中 **73 处** `await api.*` 直接调用 |
| `sessionStoreHelpers.ts` | 3699 行 |
| 两者合计 | **13070 行** |
| `sessionStore.ts` 里的 state 字段 | **789** 个 `字段:` 声明 |
| `sessionStore.ts` 对外导出的 interface/type | 20+ 个（`SessionState` 一个就 1764 行：463→2227） |

### 为什么这不合理

**它是 CLAUDE.md 硬规矩 7 的反面教材，而且是规模最大的那个。** 规矩写得很清楚：

> 渲染端新代码读数据一律走 `useRpc`（`src/renderer/hooks/useRpc.ts`），不许再手写
> `await api.*` + 自己的 loading/catch —— **429 处散装调用就是这么攒出来的。**

现在实测 **451 处**（规矩写下时是 429，**还在涨**）。这说明规矩生效不了——不是因为没人遵守，
而是因为**架构上没有一个地方让遵守变得容易**：`sessionStore` 自己就是那个"手写 api 调用"
的集合体，任何新功能的第一直觉是"往 store 加个方法"，而 store 里全是散装调用，
照抄邻居就行。

**后果链**：散装调用 = 每处自己写 loading/error/cancel → 429 变成 451 的过程里，
**每一个新增点都是一次"这个错误在 UI 上怎么显示"的独立判断** → 台账里
MC-009 / MC-011 / MC-027 / MC-031 那一类"静默失败/假成功"，根因都在这里。

### 系统性修复（不打补丁）

**分三步，每步独立可交付：**

1. **先给 `sessionStore` 减重，不是给散装调用加包装。**
   按"数据域"把 store 切开（不是按文件名切）：会话列表 / 消息流 / 编辑器状态 /
   浏览器标签 / 设置镜像。每个新 store 只暴露**动作**，不暴露 `set`——
   761 个 state 字段里有相当一部分是**别的域的镜像**，那些应该删掉而不是搬家。
   **判据**：切完之后单个 store 不应超过 ~1500 行；超了说明切的维度错了。

2. **把 `useRpc` 变成唯一读口，并把写操作收进 store 的动作里。**
   写操作可以 `await api.*`（规矩允许），但**必须**在 store 的动作里，不在组件里——
   组件里出现 `await api.*` 就是漏了。
   **可执行的验收**：加一条 CI 断言 `grep -rn "await api\." src/renderer/components | wc -l == 0`，
   让漏网的**在提交时红**，而不是靠人记。

3. **把散装调用的错误处理收敛成一份。**
   `useRpc` 已经处理了 loading/catch；450 处手写的那份要做的不是"改成 useRpc"，
   而是**先问这一处到底需要什么语义**——很多地方要的不是"显示错误"而是
   "失败时保持上次的值"或"失败时降级到空列表"，这些语义应当**有名字**（几个
   共享 hook），而不是每处各写一遍 try/catch。

**边界**：本片只做 1（切 store）+ 2 的 CI 断言。第 3 步等 store 切开之后再做——
在 9371 行上收敛错误处理，会把现有的耦合固化下来。

---

## 二、【P0】五组"同一份实现、多份副本"，其中两组有**行为差异**

### 问题在哪（逐组核对过，不是名字相同就算）

| 函数 | 份数 | 是否真重复 | 关键差异 |
|---|---|---|---|
| `readKeyMap` / `writeKeyMap` | **3** | **是，逐行同构** | ⚠️ **`secretStore` 那份坏数据时静默返回 `{}`；另两份 `log.error`** |
| `describeFsError` | **3** | **是，文案有差** | ⚠️ 同一 EISDIR，`files.ts` 说"目标不是一个文件"，`memory/store.ts` 说"不是一个文件" |
| `pathWithin` | 4 | **1 真 1 转发 2 同名但语义不同** | ✅ `ipc/skills.ts:89` 的**字面版是刻意的**（见下），不是缺陷 |
| `readJsonBody` | 3 | **是，逐行同构** | HTTP 请求体读取，三份各自实现 |
| `errText` / `describeFetchError` / `toUnpackedPath` | 3 / 3 / 3 | 是 | 语义各偏一点 |

### 两个有实际后果的

**（a）~~`ipc/skills.ts:89` 绕过 symlink 围栏~~ —— ✅ 已核实：这不是缺陷，是我判错了。**

> **2026-10-15 更正。** 本报告初稿把 `ipc/skills.ts` 那份字面路径 `pathWithin`
> 列为"绕过 symlink 围栏"的缺陷，并按其建议改成了转发给 `realPathWithin`
> —— **改完 `skills-management-smoke` 立刻红了**，红的是这条：
>
> ```
> FAIL symlink/junction deletion removes only the link, never the shared target
> ```
>
> 读源码确认了设计意图（`skills.ts:1005` 的注释）：
>
> > a symlinked skill (common when users link a shared checkout like gstack)
> > must only have the LINK removed — unlinking the target would destroy the
> > shared source.
>
> **技能目录允许是指向工区外的符号链接**，那是用户链共享 checkout 的常规做法；
> 删除分支专门用 `lstat` + `unlink` 只删链接。**字面判定正是为了让这种链接存在**。
> 换成跟物理目的地的判定，链接会被判越界 → 从列表消失、也删不掉 → 功能没了。
>
> `realPathWithin.ts` 的文件头其实早就写了这条区分（"问『这份文件是不是库里的记录』"
> 与"问『往这儿写会不会改到库』"是两问，一个函数兼不了）。我读到了那段还是判错了。
>
> **保留的改进**：原注释只写 "same logic as files.ts pathWithin" —— 那句话确实
> **误导人**（不是"same"）。已改成解释"为什么这里**必须**用字面判定"，并指向
> 那条两问区分。**代码一行未动。**
>
> **教训**（写进下面的"未做完"）：我拿"同名函数必是同义"当判据推出来的结论是错的；
> 是既有的回归网把我拦住的。**这类判断本应先跑一遍相关套件再写进报告。**

**（b）`secretStore` 的静默**（已修，见下）

三份 `readKeyMap` 逐行同构，**唯一差别**是后者不打日志：

```ts
// piModelsStore.ts / codexModelsStore.ts
} catch (err) { log.error(`piProviderKeys: failed to parse: ${(err as Error).message}`); return {}; }
// secretStore.ts  ← 少了那行
} catch { return {}; }
```

**存储损坏时，用户的 API Key 表读取失败且没有任何日志** —— 违反硬规矩 3
「坏东西显式报出来，不静默跳过」，而且发生在**凭据**上。这是真的，已修。

**（b）`secretStore` 的静默**

三份 `readKeyMap` 逐行同构，**唯一差别**：

```ts
// piModelsStore.ts / codexModelsStore.ts
} catch (err) {
  log.error(`piProviderKeys: failed to parse: ${(err as Error).message}`);
  return {};
}
// secretStore.ts  ← 少了那行日志
} catch {
  return {};
}
```

**存储损坏时，用户的 API Key 全部消失且没有任何日志。** 这正是硬规矩 3
「坏东西显式报出来，不静默跳过」的违反，而且发生在**凭据**上。

### 系统性修复

1. **`readKeyMap`/`writeKeyMap` 收敛成一份参数化的**（接受 `settingKey` + `logLabel`），
   放在 `lib/` 下。**判据**：坏数据**一律**打日志——不允许有"静默那份"。
2. **`describeFsError` 收敛成一份**放 `lib/`。文案差异说明各自在演进，
   收敛时**取更精确的那版**，然后三处共用。
3. **`ipc/skills.ts` 那处 `pathWithin` 直接删掉，改 import `pathGuard`** ——
   与 `agentTools.ts` 一样走转发。**同时**：`pathGuard.ts` 里那句
   "Implementation lives in realPathWithin.ts" 说明转发模式已经是既定做法，
   这里只是漏了一处。
4. **加一条 CI 断言**：禁止在 `src/main/**` 下**新定义**这 5 组同名函数
   （允许转发）。让"想抄一份"这件事在提交时被拦住。

**边界**：`readJsonBody` 三份里 `MobileHttpServer` 那份多了 `limit` 参数，
收敛时把 limit 做成参数而不是砍掉——那个限制是防大包攻击的，不能丢。

---

## 三、【P1】三个引擎的能力对齐没有统一判据，同类问题会一直冒

### 问题在哪

台账 MC-009 已经记了**一个实例**（`turn.incomplete` 只有 Claude 有）。我查下来这是**一类**：

| 能力 | Claude | Pi | Codex | 判据函数 |
|---|---|---|---|---|
| 上下文压缩事件 | ✅ `compact_boundary` | ✅ `compaction_end` | ⚠️ 只在注释里提 `context_compaction` | **无** |
| 回合不完整检测 | ✅ | ❌（MC-009） | ❌（MC-009） | **无** |
| fork / 会话复制 | ✅ `forkSession` | ? | ? | **无** |
| 子代理事件 | ✅ | ✅ | ✅（注释提到） | **无** |

**关键**：`grep -rn "supportsCompact\|canCompact"` **零命中**。
三个引擎各自在 `XxxMessageAdapter.ts` 里**自己判断"我支持不支持"**，
没有一个地方写着"这个能力三家各自是什么状态"。

**后果**：MC-009 不是"某处漏了"，而是**这个结构必定会持续产出 MC-009 类问题**——
每加一个引擎特有的能力，就有两个引擎悄悄落后，直到有人报告。

### 系统性修复

**照搬 mcode 自己已经做对的那个模式**——`isNodeRunnable`（台账 MC-005 修出来的）：

> 凡「某能力的实现状态」这类事实……都要有**唯一一份**判据函数，任何**面向模型的文案**
> 必须从它派生或与之断言绑定，禁止硬编码。

具体：
1. 建一个 `packages/contracts/src/engineCapabilities.ts`，按引擎列**能力矩阵**
   （`compact` / `turnIncomplete` / `fork` / `subagentEvents` / …），
   每格是 `supported | unsupported | unknown`。
2. **三个 Provider 的 `capabilities` 从这张表派生**，不各自声明。
3. **加一条跨引擎 smoke**：对矩阵里每个 `supported` 的能力，跑一次真实的
   `startTurn` 并断言事件真的到了。任何一个引擎落后 → **红**。
   这条是把"MC-009 类问题"变成**结构上不可能**的关键。

**边界**：Codex 的 `context_compaction` 我**没查到**它到底支持不支持
（只看到注释提到这个词）——这一格填 `unknown`，不猜。要确认得实际跑一次 Codex 回合。

---

## 四、【P1】桌面窗口没有 `data-reduce-motion` 总闸，且高对比度零适配

（细节见 [docs/design/claude-desktop-ui-细节逆向.md](design/claude-desktop-ui-细节逆向.md)，这里只列结论）

| 机制 | mcode | Claude |
|---|---|---|
| `data-reduce-motion`（可应用内单独开关的总闸） | **0 处** | 70 处 |
| `forced-colors`（Windows 高对比度） | **0 处** | 6 处 |
| 统一焦点环（含 danger 变体） | 各处散装 `focus-visible:ring-*` | 一份 `--cds-focus-shadow` |
| `@property`（让自定义属性可动画） | **0 处** | 90 处 |

**为什么算结构性问题而不是样式细节**：`prefers-reduced-motion` 只能表达
"跟随系统"，做不出"应用内单独开关"。而"让 AI 自己配置"是最高原则——
**"减弱动效"是个天然的、现在就缺的自配置开关**。

---

## 五、【P2】`ChatPane.tsx` 3766 行、零测试

| 文件 | 行数 | 覆盖它的套件 |
|---|---|---|
| `components/chat/ChatPane.tsx` | **3766** | **0** |
| `components/layout/LeftBar.tsx` | 2428 | 1 |
| `components/settings/CustomModelsPanel.tsx` | 2421 | 2 |
| `stores/sessionStore.ts` | 9371 | 5 |

主进程零覆盖只有 3 个文件，**渲染端最大的组件却一个套件都没有**。
`ChatPane` 是消息流主视图——渲染端最该有回归网的地方。

**修复方向**：不是"给 3766 行写测试"，而是**先按可测单元切开**
（消息块渲染 / 滚动锚定 / 输入合成 / 快捷键），每个切出来的单元配套件。
切开是第一步测试的前提，顺序不能反。

---

## 六、六条硬编码中文（i18n）在**用户可见位置**

实测：74 个文件、251 行含非注释中文字面量。其中**混着大量"本该是注释"的**——
我抽查了前 25 个文件，`BrowserPanel.tsx` / `AuthPromptDialog.tsx` 的命中几乎全是
**块注释里的中文**被正则误抓。**真正用户可见的**是这几处：

| 文件 | 数 | 性质 |
|---|---|---|
| `lib/commands.ts` | 26 | ⚠️ **命令面板的名字/描述** —— 用户直接看到 |
| `lib/appControlHost.ts` | 18 | ⚠️ 宿主侧用户可见提示 |
| `components/settings/HooksPanel.tsx` | 10 | 设置界面文案 |
| `components/ide/MergeConflictResolveDialog.tsx` | 8 | 冲突解决对话框 |
| `pair.ts` | 20 | ✅ **已查明是有意的**（见下） |

**`pair.ts` 不是问题。** 它的文件头写着：这个页面是手机扫码后落地的**独立页**，
**故意不引 React / sessionStore / webApi**，为的是"手机几 KB 就能看到配对界面，
慢的 VPS/中继链路上首帧也立刻出来"。**独立性是它的设计目标**——接 i18n 会把
词典和 core 拉进来，那正是它要避免的。

这与 Claude 桌面端 `quick_window` 把 18px logo 内联（而不是拉一个组件框架）
是**同一个取舍**：**"少一个运行时"比"少一份重复"重要**。
所以在 74 个命中里，`pair.ts` 那 20 处应当从清单里划掉。

**为什么是结构问题**：`zh` 是 `MessageId` 类型的源，缺 key 会 **typecheck 失败**——
这套机制设计得很好。硬编码绕过了它，于是**这些文案永远不会出现在 en 词典里，
而且没有任何机制会发现**。

**修复**：按文件清理，先做 `lib/commands.ts`（28 ID 的命令面板，改一处修一整片）。
**加一条断言**：`src/renderer` 下非注释中文行数不增长（棘轮），
防止清了又涨。

---

## 七、逐条结论：哪些值得做、哪些不值得

| # | 问题 | 值不值得做 | 为什么 |
|---|---|---|---|
| 一 | 451 处散装 + 9371 行上帝对象 | **最值得** | 它是**其他很多问题的根因**（静默失败、状态不一致）；而且还在恶化 |
| 二 | 5 组重复实现（1 组有行为差异） | **值得，且便宜** | 收敛成本低；`secretStore` 那处静默**安全相关**。⚠️`pathWithin` 已排除（是我判错） |
| 三 | 三引擎能力无统一判据 | **值得** | 不做的话 MC-009 类问题会**持续再生** |
| 四 | 动效总闸 / 高对比度 | **值得，便宜** | 半天量级；同时补无障碍缺口 + 一个自配置开关 |
| 五 | ChatPane 3766 行零测试 | 值得，但**成本高** | 要先切开才能测；排在切 store 之后 |
| 六 | i18n 硬编码 | 中等 | 量不大但要逐个看语境，`pair.ts` 可能是有意的 |

**不做 / 只记着**：
- 三层 token 重构（mcode 现在 8 个语义 token 够用，等"用户自定义主题"需求来了再做）
- Tailwind v4 升级（一次性大面积变化，要专门起一轮）
- 抄 Claude 的 216KB 巨型 CSS（mcode 的按需产出是对的）

---

## 八、没做完 / 不确定的（如实写）

1. **Codex 到底支不支持上下文压缩** —— 只在注释里看到 `context_compaction` 字样，
   没找到实现。填 `unknown`，要实际跑一次 Codex 回合才能确认。
2. **`pair.ts` 的 20 处中文 —— 已查明，不是问题**（它有意零依赖，见第六节）。
   仍**未查**的：`appControlHost.ts` 那 18 处到底是给用户看的还是给日志/Agent 看的
   （那是个宿主侧模块，可能像 `pair.ts` 一样有"不引词典"的理由）。
3. **`emit` 8 份同名函数** —— 我只数了名字，**没逐个核对**是不是真重复
   （`emit` 这种名字在不同上下文里意思可以完全不同）。**不列入清单**，需要时再核。
4. **两个子代理的报告我整合了主要结论**，但工具契约层的逐条细节
   （Claude 每个工具的硬性约束 vs mcode 的对应）没有完整写进本文——
   那部分更适合直接进台账，按 MC 编号维护。
5. **本文全部是 E2**。没有一条做过变异验证，没有一条有 E1 红/绿例。
6. **⚠️ 本报告出过一次实打实的误判**（`pathWithin`，见第二节 (a) 的更正）：
   我把"同名函数"当成了"同一语义"，据此判定 `ipc/skills.ts` 绕过 symlink 围栏
   —— 错的。该函数是**刻意**的字面判定，为的是允许符号链接指向共享 checkout。
   是既有的 `skills-management-smoke` 把我拦住的。
   **教训**：结构性判断在写进报告前，应先跑一遍相关回归网；
   "同名"不是判据，"读注释 + 跑测试"才是。
