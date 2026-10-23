# T88｜`tsx-coverage-smoke` 的断言锚在一个已被删掉的字符串上

- Status: ready-for-agent
- Category: **测试有效性（T78 引入的回归）**
- Priority: **P1** —— 全量 561 套里唯一由今天改动引入的真失败
- Depends on: T78（`ddff6117`，改了 `smokes-for.py` 输出格式）
- Exclusive writable files: `apps/desktop/scripts/tsx-coverage-smoke/main.py`

## Required Skills
- `mcode-smoke`：断言与格式解耦。

## 背景：全量唯一由今天引入的失败

```
FAIL  tsx-coverage-smoke (exit=1)

FAIL .tsx 与 .jsx 入口都被扫到：ApprovalPrompt.tsx 映射到两个套件: '...'

FAIL 同一套件的 .tsx 入口也能带出 .ts 依赖: '...'

FAIL .ts 入口（同一套件里 cjs 是启动器）仍被认出覆盖: '...'
```

### 根因（B 查的，`git log -S`）

```bash
$ git show ddff6117^:apps/desktop/scripts/smokes-for.py | grep "跑这些"
173:            print("  跑这些: " + " ".join(hits))
```

**T78（`ddff6117`）把输出从 `跑这些: A B` 改成了带「必跑」「跳数」的多段格式。**

而 `tsx-coverage-smoke/main.py:139` 还在断言：

```python
check(".tsx 与 .jsx 入口都被扫到：ApprovalPrompt.tsx 映射到两个套件",
      "跑这些: jsx-entry-smoke tsx-entry-smoke" in r.stdout, r.stdout + r.stderr)
```

**那句话不存在了，这条断言永远不可能再通过。**

## 任务

### 三条断言全部改成「与格式解耦」

**不要**把新格式的字面写死（那样下次改格式还会红）。

```python
# ❌ 旧：锚在格式上
"跑这些: jsx-entry-smoke tsx-entry-smoke" in r.stdout

# ✅ 新：只验它该验的 —— 两个套件名都出现在输出里
all(s in r.stdout for s in ("jsx-entry-smoke", "tsx-entry-smoke"))
```

**三条同样处理**：

| 断言 | 该验什么 |
|---|---|
| `.tsx` 与 `.jsx` 入口都被扫到 | `jsx-entry-smoke` **和** `tsx-entry-smoke` 都出现 |
| 同一套件的 `.tsx` 入口能带出 `.ts` 依赖 | `tsx-entry-smoke` 出现 |
| `.ts` 入口（cjs 是启动器）仍被认出覆盖 | `cjs-runner-smoke` 出现 |

### 顺带收紧：detail 太长会淹没失败信息

B 指出：

> `r.stdout + r.stderr` 作为 detail 会打印整个帮助文本——这次失败的信息里那一大段 `必跑（1–2 跳，2 套）` 就来自这里。**detail 太长会淹没失败信息。**

**改成截断**（比如只取前 300 字符，或只取包含关键字的行）。

### 必须验证的三件事

1. **改完三条全绿**；
2. **变异**：把 `smokes-for.py` 的输出改回旧格式（临时），三条仍绿 → 证明真的与格式解耦；
3. **变异 2**：让 `smokes-for.py` 不输出 `tsx-entry-smoke`（临时），第一条必须红 → 证明它仍在验覆盖。

**第 2 条最重要**：它证明「改格式不会再让这套红」。

## 验收判据

1. 三条断言与输出格式解耦（有变异证据）。
2. detail 截断。
3. 套件全绿。
4. **不依赖 `smokes-for.py` 的任何字面格式**（`grep "跑这些"` → 零命中）。
5. 不跑全量、不起 Electron。

## 边界

- **只改 `apps/desktop/scripts/tsx-coverage-smoke/main.py`**；
- **不改 `smokes-for.py`**（那是 T78 的产物，格式是对的）；
- 不改产品代码。

## 遇到问题先检索

`smokes-for.py` 的三种输出（`--all` / 单文件 / `--uncovered`）形状各不同，**先读它再改断言**。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T88-tsx-coverage-decouple.md` 末尾追加 `## 结果回写（2026-10-24）`：
三条改前/改后、两次变异结果、套件数字、提交 SHA。
