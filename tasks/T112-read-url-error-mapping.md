# T112｜`agent_read_url` 的 `fetch failed` 是一条无法使用的错误

- Status: ready-for-agent
- Category: **P1 产品缺陷（模型看到无法判断的错误）+ 测试稳定性**
- Priority: **P1 —— 它同时是「用户看不懂的错误」和「全量随机红」的同一个根因**
- Depends on: T112 的现场（第三轮全量 `document-read-smoke` 偶发红，单独跑 140/140）
- Exclusive writable files:
  - `apps/desktop/src/main/mcp/agentToolRuntime.ts`（`readUrlText` 的 catch 块）
  - `apps/desktop/scripts/document-read-smoke/main.ts`

## Required Skills
- `mcode-smoke`：错误映射的正负控 + 变异。

## 现象

**第三轮全量里 `document-read-smoke` 红了一条**：

```
FAIL ★ 二进制 Content-Type 被拒绝并指向文档/图片工具 — 失败:fetch failed
document-read: 139 passed, 1 failed
```

**单独跑：140/140 全绿。**

**所以是偶发。但断言红的原因不是那条断言想验的东西** —— 它想验「二进制 Content-Type 被拒绝」，而实际是**连接没建立**。**这是「红了但红错地方」的又一次。**

## 根因：catch 只翻译 AbortError

`agentToolRuntime.ts:1650-1655`：

```ts
} catch (err) {
  if ((err as Error).name === "AbortError") throw new Error(`读取 URL 超过 ${budget.maxTimeMs}ms`);
  throw err;
} finally {
  clearTimeout(timer);
  urlReadGate.release();
}
```

**`fetch` 在连接层失败时抛的是 `TypeError: fetch failed`，`cause` 里才带真实原因**（`ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT` / `EPIPE`）。

**而它被原样抛出**，于是：

1. **模型看到 `失败:fetch failed`** —— 它没法判断该重试、该换 URL、还是该告诉用户服务挂了；
2. **套件的断言拿到 `fetch failed`** —— 它匹配的是 `/二进制|agent_read_document|agent_read_image/`，**不匹配**，所以红在了一个跟它无关的位置。

## 这不是「把错误翻译得好看点」

**`CLAUDE.md` 硬规矩 3：坏东西显式报出来，不静默跳过。**

**现状不是「没报」** —— 是**报了一句无法用于判断的信息**。

**对比同一个仓库里做对的地方**：`rgInstall.ts:220` 的注释写着：

> `fetch` reports almost everything as `TypeError: fetch failed` (or the bare ...)

**那里已经处理过这件事。** `readUrlText` 没有。

## 顺带：这不是唯一的偶发红

**今晚同一形态出现了两次**：

| 套件 | 全量 | 单独跑 |
|---|---|---|
| `mcode-node-pack-smoke` | 365/390（25 条 `mcode-*` 缺失） | 390/393 全绿 |
| `document-read-smoke` | 139/140（`fetch failed`） | 140/140 全绿 |

**两个都不是「套件写得差」，是「并行负载下本地 HTTP/子进程偶发失败，而失败信息不足以区分」。**

**`document-read-smoke` 这条是本卡要修的**；`mcode-node-pack` 那条已经单独确认过（B 的探针连跑 5 次稳定），**但它的偶发原因还没查清**——见本卡第四节。

## 任务

### 一、`readUrlText` 的 catch 要展开 `cause`

**要求**：`fetch` 的 `TypeError` 要拆出 `cause` 里的 `code` / `message`，给出一句**能用于判断的**中文错误。

**形状（你判断措辞）**：

```
读取 URL 失败：连接被拒绝（ECONNREFUSED）—— 目标端口没有服务在监听
读取 URL 失败：域名解析失败（ENOTFOUND）—— URL 里的主机名不存在
读取 URL 失败：连接超时（ETIMEDOUT）
读取 URL 失败：<原始 message>（<code>）
```

**必须有「无法归类」的兜底分支**，且**必须保留 `cause.code`**（排查的唯一线索）。

### 二、⚠️ 一个必须小心的边界

**「连接被拒绝」和「Content-Type 是二进制」在断言层面必须分得开。**

现在那条断言是：

```ts
assert.equal(out.isError, true, t);
assert.match(t, /二进制|agent_read_document|agent_read_image/, t);
```

**它现在会红在「连接失败」上** —— 因为 `isError: true` 成立，而第二条不匹配。

**你要判断的**：

**选项 a**：改断言，先断言「错误里不含 `fetch failed`」（证明连接建立了），再断言 Content-Type 那一条。
**选项 b**：在套件里对本地 server 加**就绪等待**（等 `listening` 事件后再发请求），并且**只在这一条上重试一次**。

**我倾向 a + b 都做**：
- **a** 让「红在哪」这件事变清楚；
- **b** 让偶发本身减少。

**但 b 有一个风险**：**重试会掩盖真实的连接问题。** 所以**重试必须 log 一行**（「第 N 次重试」），否则「重试掩盖了什么」没人知道。

### 三、正负控

| 用例 | 期望 |
|---|---|
| 连一个**没有服务**的端口 | 错误含 `ECONNREFUSED` 或「连接被拒绝」，**不含** `fetch failed` 原文 |
| 正常 HTTP 200 | 成功，正文正确 |
| **回归**：二进制 Content-Type | 仍然是「请改用 agent_read_document / agent_read_image」 |
| `timeout_ms` 到点 | 仍是「读取 URL 超过 Nms」 |

### 四、`mcode-node-pack-smoke` 的偶发（如果时间允许）

**B 已经连跑 5 次稳定**，所以它不是随机失败。**全量里 365/390 的原因仍未查清。**

**如果你有时间**：查一下那一轮（`1792776672947-29220-W0Jor1`）的日志和单独跑的差异。

**⚠️ 但这不是本卡的必做项** —— `document-read-smoke` 的偶发才是。

## 验收判据

1. **`fetch failed` 不再原样出现在用户/模型可见的错误里**（有断言）。
2. **`cause.code` 被保留**（有断言）。
3. **连接失败 vs 二进制 Content-Type 两条错误可以区分**（两条断言各自匹配自己的文案）。
4. **`document-read-smoke` 连跑 5 次全绿**（证明偶发减少）。
5. **变异**：把 catch 改回 `throw err` → 新断言红。
6. **变异**：把 `cause` 丢掉 → 「保留 code」那条红。
7. 不跑全量、不起 Electron。

## 边界

- **只改 `readUrlText` 的 catch 块**，**不改 `readResponseWithinBudget` / `classifyContentType` / 重定向逻辑**；
- **只改 `document-read-smoke` 的那一条断言 + 就绪等待**，**不改其他断言**；
- **不碰 `mcp/agentTools.ts` 的 `attempt()` 包装**（那是重试策略，改它影响所有工具）。

## ⚠️ 写卡的自我约束

**本卡第一节给的「形状」是四个示例串，不是要求原文照抄。** 你要按 `cause.code` 的实际取值决定分支 —— **先跑一遍看 undici 在 Windows 上各类失败给什么 code**，再写映射。

**（2026-10-24 我给的代码示例有两条事实错误，D 用四条命令核实出来。这次不重复。）**

## 遇到问题先检索

```bash
sed -n '1596,1660p' apps/desktop/src/main/mcp/agentToolRuntime.ts
grep -n "fetch failed" -A 10 -B 5 apps/desktop/src/main/lib/rgInstall.ts
grep -n "二进制 Content-Type" -A 20 apps/desktop/scripts/document-read-smoke/main.ts
```

**`rgInstall.ts:220-270` 那段是同一个仓库里已经解决过这个问题的先例** —— 先读它。

## 回写

`tasks/T112-read-url-error-mapping.md` 末尾追加 `## 结果回写（2026-10-24）`：
`cause.code` 的实测取值、映射表、两条错误怎么区分、连跑 5 次结果、变异、提交 SHA。
