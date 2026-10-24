# F002｜VSIX 兼容第一步：让 DEFLATE 的包能读进来

- Status: ready-for-agent
- Category: **P0 扩展主线**（路线图 §2「尽可能让已有 VS Code 插件（含 VSIX）少改或无需修改即可运行」）
- Depends on: F001（`ec33c700`）、T80（`ecb5035a` 四层实测）、`docs/planning/extension-vscode-compat.md`
- 前置裁决：**用户 2026-10-24 明确「路线图为准，做 VSIX」** —— T85 的「不做」已被推翻
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`
  - `apps/desktop/scripts/vsix-deflate-smoke/`（新建）
  - 本卡回写

## Required Skills
- `mcode-smoke`：字节级断言 + 变异。

---

## 为什么先做这一层，而不是先放宽尺寸

`VscodeL1Bridge` 现在有**六道硬限制**，都在代码里写死：

| # | 限制 | 出处 | 真实扩展 |
|---|---|---|---|
| 1 | 总包 ≤ **128 KiB** | `:59` | 3.0 MB（差 24 倍） |
| 2 | **只认 STORE**，不认 DEFLATE | `:57` 注释 + `:79` `method` 校验 | 市场扩展**一律 DEFLATE** |
| 3 | 恰好 2 个 entry | `:69` `u16(...)!==2` | 数十个 |
| 4 | `manifest` ≤ 4096 B、`main` ≤ 24 KiB | `:117` | 可达数百 KB |
| 5 | `main` 必须字面量 `./extension.js` | 清单校验 | 各式路径 |
| 6 | `require` 白名单只有 `"vscode"` | 运行时 | 53 个 `vscode.*` 成员 |

**第 2 条是根**：不认 DEFLATE，其余五条都没有意义——因为真实扩展**一个都进不来**。
先放宽尺寸、先改清单，都还是会被 DEFLATE 卡住。

**所以本卡只做一件事：让 DEFLATE 的 ZIP 能读出来。**

---

## 任务

### 一、`readMinimalVsix` 支持 DEFLATE（method 8）

**这个仓库已经有先例，照它做，别自己发明**：

```ts
// apps/desktop/src/main/document/pageFitCheck.ts:43
import { inflateRawSync } from "node:zlib";
```

`pageFitCheck.ts:198` 的注释还写了为什么选它：「而为了读一个 XML 引一个新包不值得 ——
**`node:zlib` 的 `inflateRawSync` 就是**」。

另外 `crc32` 在 `apps/desktop/src/main/mcp/agentToolRuntime.ts:20` 也是从 `node:zlib` 引的。

**所以**：
- **用 `inflateRawSync`**（raw deflate，正是 ZIP 用的），**不要手写 inflate**；
- **不要引第三方包**（`pako` / `fflate`）—— 仓库里没有，而 `node:zlib` 够用；
- ⚠️ **别用 `inflateSync`**：那是带 zlib 头的，ZIP 的 DEFLATE 是 **raw**，用错会报
  `incorrect header check`，而且这个错误看起来像「包坏了」，容易误判到数据上去。

（注意：`pageFitCheck.ts` 那个用途是解 xlsx 的 deflate 流，和这里同构 —— 可以先读它怎么处理
错误与尺寸，但**别把它整段抄过来**，那是另一个模块的职责。）

### 二、**尺寸与 entry 数限制，本卡一律不放宽**

**这一点必须守住**：本卡只验「DEFLATE 能读」，**不放宽 128 KiB / 2 entry / 24 KiB**。

**理由**：放宽尺寸会让「一个能读但跑不起来的大包」混进来，而失败点会从「包读不进来」
变成「读进来了但 vscode API 全缺」——**后者难诊断得多**。

**先让读这一层正确，尺寸单独一张卡。**

### 三、校验和不能跳过

DEFLATE 解压后**必须验 CRC32**。现在 `:108` 有一段手写的 CRC32，**解压路径也要过同一套校验**。

**理由**：不验 CRC 的解压 = 静默接受损坏的包，而损坏的包会在更远的地方炸（运行时），那时已经查不到源头了。

### 四、拒绝路径要显式

解压失败（损坏的 deflate 流、CRC 不匹配、声明尺寸与实际不符）必须：

- **抛出明确的错误信息**（说清是哪种失败），不是笼统「VSIX invalid」；
- **不能静默返回空**（硬规矩 3）。

---

## 验收判据

1. **一个真实 DEFLATE VSIX 能读出 `package.json` 与 `extension.js`** —— 用本机 `~/.vscode/extensions/` 里任一个真实扩展重新打包成 DEFLATE 测（**不要联网下载**）；
2. **STORE 路径仍工作**（正控：不能为了 DEFLATE 弄坏原有路径）；
3. **CRC 不匹配时抛错**（负控）；
4. **超出 128 KiB 仍拒绝**（负控：本卡没放宽尺寸）；
5. **2 entry 限制仍在**（负控）；
6. 套件条目数你自己定，但**每条都要能红**；
7. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| DEFLATE 分支删掉、退回只认 STORE | **1 条红**（真实扩展读不出） |
| CRC 校验去掉 | **1 条红**（负控那条） |
| 顺手把 128 KiB 改成 16 MiB | **1 条红**（尺寸负控） |
| 解压后不验声明尺寸 | 视断言而定，**你要明确写了哪条守它** |

**第三行是防我自己**：本卡说了不放宽尺寸，如果有人顺手放宽，套件必须红。

---

## 边界

**只改**：
- `apps/desktop/src/main/modules/vscodeL1Bridge.ts`
- 新建 `apps/desktop/scripts/vsix-deflate-smoke/`
- 本卡末尾回写

**不碰**：
- `ModuleHost`（`main/modules/moduleHost.ts` 等）——**那是已交付的自有扩展路径**；
- `packages/contracts/**`；
- `CLAUDE.md`（已完成，别重复改）；
- `tasks/F/F001-extension-honesty.md`。

---

## 遇到问题先检索

- `docs/planning/extension-vscode-compat.md` §3（分级表）、§4（L1 实际限制）、§6.2
- T80 的 `ecb5035a`：四层实测数据
- `apps/desktop/src/main/modules/vscodeL1Bridge.ts:57-120`（ZIP 解析全貌）

---

## 回写

本卡末尾追加 `## 结果回写`：

1. **用的是 `node:zlib` 还是手写 inflate**，为什么；
2. **真实扩展是哪一个**（名字 + 版本），重新打包后多大；
3. 六道限制里，**本卡动了几道、没动哪几道**（必须明确说没放宽尺寸）；
4. 变异四条的结果（预期 vs 实际）；
5. 提交 SHA。

---

## 结果回写

### 1. 用的是 `node:zlib` 的 `inflateRawSync`，不是手写

```ts
import { inflateRawSync } from "node:zlib";
```

理由：仓库里已有两处先例（`document/pageFitCheck.ts:43` 解 xlsx 的 deflate 流、
`mcp/agentToolRuntime.ts:20` 从同一个模块引 `crc32`），**不为读一个 ZIP 引第三方包**。

**没有用 `inflateSync`** —— 那是带 zlib 头的，ZIP 的 DEFLATE 是 raw。
用错会抛 `incorrect header check`，而那个错误看起来像「包坏了」，会把下一个人引到数据上去查。
这一点写进了代码注释，不只是写在卡里。

### 2. 真实扩展是哪一个，重打包后多大

`mechatroner.rainbow-csv-3.24.1`（本机 `~/.vscode/extensions/` 里唯一有顶层
`extension.js` 的那个，也是 T80 用过的）。

| 项 | 值 |
|---|---|
| `package.json`（原始） | **17 021 B** |
| `extension.js`（原始） | **136 516 B** |
| 重新打包成 DEFLATE 后 | **34 467 B = 33.7 KiB**，**在 128 KiB 总限额内** |

### 3. ⚠️ 六道限制里本卡动了 0 道 —— 但真实扩展仍进不来，原因不在本卡

**明确说：128 KiB / 2 entry / 4096 B manifest / 24 KiB main，一条都没放宽。**

但拿真实扩展的文件去实测，结果是：

```
真实文件: package.json 17021 B, extension.js 136516 B
重新打包成 DEFLATE: 34467 B = 33.7 KiB
  128 KiB 总限额: 包本身合规
结果: 被拒 → Error: VSIX DEFLATE entry declared size exceeds L1 bound: extension/package.json
```

**这是本卡最重要的发现，我没有绕过它：**

- **总尺寸不是瓶颈** —— 真实扩展的两个文件压完才 33.7 KiB，远在 128 KiB 内；
- **真正的瓶颈是单文件限额**：`package.json` 17 KB 超 4096 B 限额 **4.2 倍**；
  `extension.js` 136 KB 超 24 KiB 限额 **5.6 倍**。

**所以「让真实扩展能装」的下一道墙不是 DEFLATE，是这两个单文件限额。**
它们 `:117` 写死，本卡按指令没动。

**这对下一张卡的含义**：即使把 `package.json` 放宽到 32 KiB，`extension.js` 还得从
24 KiB 放到 128 KiB 以上——而后者正是本卡**刻意没做**的那种放宽（理由：会让失败点
从「包读不进来」变成「读进来了但 API 全缺」）。

**建议**：下一张卡先只放宽 `package.json` 到 32 KiB（它是**声明**，不是可执行代码，
放宽风险低），再单独评估 `extension.js` —— 那一步才是真正需要配套 API 面的。

### 4. 变异四条：预期 vs 实际

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 DEFLATE 分支删掉、退回只认 STORE | 红 5 条左右 | **红 6 条**（[2] 3 条 + [3] 3 条，含新增的「读取成功」断言） |
| M2 CRC 校验去掉 | 红 2 条 | ✅ **红 2 条** |
| M3 把 128 KiB 改成 16 MiB | 红 2 条 | **红 1 条**（见下） |
| M4 解压后不验声明尺寸 | 红 2 条 | ✅ **红 2 条** |

**M3 只红 1 条不是覆盖不足，是我预期写错了。** 放宽总尺寸后那个 200 KiB 的包**仍然被拒** ——
只是换成了后面的 24 KiB 条目限额。所以「被拒绝」那条仍然绿是**正确的**；
真正该红的是「被哪道限制拒的」，它红了：

```
FAIL ★ 拒绝理由是「总尺寸超限」而不是条目限额（区分是哪道限制）
      {"error":"Error: Missing or oversized VSIX manifest/entry"}
```

**这条断言是我第一版没写的** —— 第一版只验「抛错了」，M3 下照样绿。
发现之后补成「必须点名 `size out of L1 bounds` 且不能是条目限额」。

### 5. 套件第一版的另一个坑（同上轮同类）

第一版 [2] 组直接 `readMinimalVsix(zip)`，没包 try/catch。M1 让它在 [2] 抛出未捕获异常，
**整个套件当场终止，后面 19 条一条都没跑** —— 输出只剩 `0`（0 条 FAIL），
看起来像「没红」，实际是「没跑」。改用 `safeRead` 包装后，失败变成一条 FAIL，其余照跑。

这正是上轮「断言没跑和断言通过分不开」的同一形态（CLAUDE.md 第八条 #7）。

### 6. 提交

`5e91296f`（4 文件，+388/−6）。
套件 `apps/desktop/scripts/vsix-deflate-smoke/`，**24 条，全绿**；
四条变异全部按预期或按更强理由变红；还原逐字节 `SAME`；
`npx tsc --noEmit -p apps/desktop/tsconfig.json` exit 0。

### 7. 觉得不对但没改的

1. **单个文件限额是本卡之后真正的墙**（见 §3）—— 卡里说本卡不放宽，我照做，
   但这意味着「让真实扩展能装」还需要至少一张卡。**这一条建议写进路线图**，
   否则下一张卡还会以为「DEFLATE 做完就能装了」。
2. `crc32` 现在手写了一份（`:105` 附近）。Node 22 的 `node:zlib` 有 `crc32`，
   但**换掉它会影响 STORE 路径的既有断言**，超出本卡边界，没动。
3. 卡里 `## Required Skills` 只列了 `mcode-smoke`。够用，没别的要求。
