# T61｜反查「测试绿着但实际没验」的套件

- Status: ready-for-agent
- Category: 测试基础设施审计（P1）
- Priority: P1
- Depends on: 无
- Exclusive writable files: **只读 + `.tmp/` 下的探针**。不改任何产品文件、不改任何套件。

## Required Skills
- `mcode-smoke`: 理解这套无头 smoke 的断言写法与变异验证。

Read before work: `CLAUDE.md`（**「任何断言的价值都不超过它取证方法的正确性」与「注释里也有没人验的断言」两节**）、`apps/desktop/scripts/browser-smoke/main.ts`（**B 今天刚发现的实例**）。

## 背景：今天三次同一类问题

### ① T24 的 59/59 全绿，但 `withRendererToolRegistry` 从未被调用

T24 的套件**自己在测试里调了** `withRendererToolRegistry`，而生产装的是未包装的 ports。**套件测了正确的东西，但产品装配的是另一份。**

T40 才发现（`9487eaa4`）。

### ② `browser-smoke` 296/296 全绿，但那个常量根本不是断言的对象

B 今天做变异：把 `PROJECT` 改成 `process.cwd() + "\\totally-different-root"`（指向一个不存在的兄弟目录）→ **296/296 仍然全绿**。

**那个值只作为「一条具体的根路径样本」参与判定，具体指向哪里无关。** 问题只剩注释里那句「PROJECT 是本仓库根，**真实存在**」——**296 条断言里没有一条在检查这句话。**

### ③ `markdown-mode-smoke` 的注释「真实存在」也是同一类

## 任务

**找出「变异后仍然全绿」的套件。**

### 方法

对每个套件做一次「无效变异」测试：

```bash
cd "D:/副桌面/文件夹/work_space/work_for_reseach/mcode/apps/desktop"

# ① 看它的核心断言依赖什么
head -60 scripts/<suite>/main.ts

# ② 设计一个「把被测对象改成明显错的」的变异
# ③ 跑 → 如果仍然全绿 → 它没在验那个东西
# ④ 还原 → cmp 确认逐字节一致
```

### 优先查这四类（最可疑）

1. **断言只检查「存在」不检查「内容」**：
   ```ts
   check("xxx 存在", existsSync(p))
   ```
   → 把文件内容改成垃圾还绿吗？

2. **断言比较的是「同一个值」两次**（恒真）：
   ```ts
   eq("url 正确", f(input), EXPECTED)   // EXPECTED 也是从 f 算出来的？
   ```

3. **断言检查源码文本形状**：
   ```ts
   check("有 xxx 调用", src.includes("xxx("))
   ```
   → 注释掉还能绿吗？

4. **`SKIP` / `TODO` / 条件跳过的分支**

### 产出

**`docs/planning/assertion-integrity-audit.md`**（新建）：

| 套件 | 可疑断言 | 变异方式 | 结果 | 判断 |
|---|---|---|---|---|
| `xxx-smoke` | `check("文件存在")` | 内容改成垃圾 | 仍绿 | **空过** |
| `yyy-smoke` | `eq("url", f(x), f(x))` | 常量改成别的 | 仍红 | 有判别力 ✓ |

**按严重程度排序**：`空过（断言完全无效）` > `弱（只验存在）` > `可接受`。

## 验收判据

1. **至少查 20 套**，优先查名字带 `t2x`/`t3x`/`t4x`/`t6x` 的（今天新写的）。
2. **每条判断必须有变异证据**（不能靠"看起来弱"下结论）。
3. **变异还原后 `cmp` 逐字节一致**（写进报告）。
4. **发现「空过」的套件必须点名**，说明它本该验什么、实际验了什么。

## 边界

- **只读 + `.tmp/` 下的探针**；
- **不改任何产品文件、不改任何套件**（发现的问题只报告，修复另开卡）；
- **不跑全量**（按用户规矩，全量由总控执行）；
- **不起 Electron**。

## 遇到问题先检索

变异脚本踩过的坑（见 `CLAUDE.md`）：`assert s.count(old) == 1` 在 `old` 已被替换过时会**在写文件之前抛错退出**——那时文件没改、套件没跑，但人会误读成「跑过了、证据被吞」。**变异后先 `git diff` 看改动在不在，再跑。**
