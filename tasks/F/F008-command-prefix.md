# F008｜命令前缀规则让 100% 的真实扩展装不上

- Status: blocked-by-F004（**等 F004 释放 `vscodeL1Bridge.ts`**，它正占着 `:480-500`，与本卡冲突）
- Category: **P0 扩展主线（最高优先级的墙）**
- Depends on: F005（`9d49aa39`，实测出三道串联的墙）
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`（**`install` 里那段前缀校验**）
  - `apps/desktop/scripts/vsix-command-prefix-smoke/`（新建）
  - 本卡回写

## Required Skills
- `mcode-smoke`

---

## 证据：这条规则不是偏严，是让所有人装不上

我（总控）对**本机 29 个真实 VS Code 扩展**做了盘点：

```
扩展总数           29
命令全带 publisher.name 前缀  →  0
```

三个具体的：

| 扩展 | 命令数 | 带前缀 |
|---|---|---|
| `mechatroner.rainbow-csv` | 24 | **0** |
| `james-yu.latex-workshop` | 46 | **0** |
| `minko.image-manager` | 5 | **0** |

真实扩展的命令名长这样：

```
rainbow-csv.CSVLint          ← 是 name.command，不是 publisher.name.command
rainbow-csv.SetHeaderLine
```

而宿主强制：

```ts
// vscodeL1Bridge.ts:487-488
const prefix = pkg.publisher + "." + pkg.name + ".";
if (!commandId.startsWith(prefix)) throw Error("VSIX command must use its publisher/name prefix");
```

`mechatroner.rainbow-csv.` 这个前缀，**没有任何一个真实扩展用**。

---

## 这条规则哪来的

`git log -S "publisher/name prefix"` → `68a7121c`（`feat(arc-006): prototype scoped VSIX L1 command bridge`）。

**和 4096 / 24576 / 128 KiB / 2 entry 是同一个提交、同样没有依据。**

**F003 已经证明那批数字是随手定的。这条规则是同一批。**

---

## 任务

### 一、把规则改成真实生态的形态

VS Code 的真实约定是：

- 命令 id **应该是** `<publisher>.<name>.<command>`（官方推荐），
- **但大量扩展实际用 `<name>.<command>`**，VS Code 本身**不强制**，
- 只要全局唯一即可。

**所以正确的校验是**：

1. **命令 id 必须唯一**（同一份清单内不能重复）；
2. **必须带一个点**（形如 `x.y`，不是裸词）；
3. **前缀应当匹配 `publisher.name` 或 `name`** —— **两者都接受**。

**不要完全去掉前缀检查** —— 那会让扩展能声明别的扩展的命令 id。
**但要把 `name.command` 这个真实形态放进来。**

**如果你认为「应该只接受 `publisher.name.`、连 `name.` 也拒」**，在回写区论证，别默默改。

### 二、这个改动会让「命令路由」出现问题 —— 必须一起解决

现在 `executeCommand` 里有：

```ts
if (commandId !== this.commandId) throw Error("Undeclared VS Code command");
```

**单命令硬编码。** 前缀放宽之后，用户能声明的命令变多，这条会更容易撞。

**本卡不解决多命令**（那是另一张卡），但**必须确认**：

- `this.commandId` 仍然取自 `pkg.contributes.commands[0].command`；
- **放宽前缀不会让 `commandId` 的取值出歧义**。

**如果有歧义，写进回写区，别自己扩成多命令。**

### 三、错误信息

拒绝时要说清**它期望什么**，不是只说「不符」：

```
// 现在
Error("VSIX command must use its publisher/name prefix")

// 应该
Error("VSIX command id must start with '<publisher>.<name>.' or '<name>.' (got 'xxx')")
```

**F003 已证明：说不清被哪道拒的，变异就无法断言。**

---

## 验收判据

1. **`rainbow-csv` 的命令前缀检查通过**（`rainbow-csv.CSVLint` 被接受）；
2. **`<publisher>.<name>.<cmd>` 仍然被接受**（正控：别弄坏本来支持的）；
3. **不带点的裸命令被拒**（负控）；
4. **`publisher.name.` 和 `name.` 都不匹配的命令被拒**，错误信息说清期望什么（负控）；
5. **同清单内重复命令 id 被拒**（负控，如果现在有这条校验就保留，没有就加）；
6. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| 完全去掉前缀检查 | 1 条红（`publisher.name.`/`name.` 都不匹配那条负控） |
| 只接受 `publisher.name.`（回到旧规则） | 1 条红（rainbow-csv 被拒） |
| 允许裸命令（不要求有点） | 1 条红（裸命令负控） |

**⚠️ 不要用「删掉一条断言」来验变异** —— F005 实测：**删掉断言，套件不会红，它只是少了一条**。
必须先写「预期红几条」，再看实际。

---

## 回写

1. 最终接受的**两种前缀形态**，以及你拒绝的形态；
2. 为什么**不完全去掉**前缀检查；
3. `rainbow-csv` 的 24 条命令现在过了几条（**应该全过**，如果还有别的墙就在这说）；
4. 变异三条结果；
5. **`commandId` 取值有没有出歧义**；
6. 提交 SHA。

---

## 结果回写

### 1. 接受的两种前缀形态，以及拒绝的形态

**接受**（先试更严格的那个）：

| 形态 | 例子 |
|---|---|
| `<publisher>.<name>.<command>` | `acme.demo.hello` |
| `<name>.<command>` | `rainbow-csv.CSVLint` |

**拒绝**：

| 形态 | 例子 | 理由 |
|---|---|---|
| 裸命令（无点） | `hello` | 不是合法命令 id |
| 两个前缀都不匹配 | `other.thing` | 不是自己扩展的命令 |

**实现顺序有意义**：先试 `publisher.name.`，再退到 `name.` —— 这样错误信息能说清
「它至少匹配了哪一种」。实测本机**没有** `publisher === name` 的扩展，
所以两种形态不会重叠、不存在「同一 id 两种解读」。

### 2. 为什么**不完全去掉**前缀检查

去掉之后扩展能声明**别的扩展**的命令 id（比如它声明 `git.commit` 并接管）。
那不是「放宽」，是**越权命名**。

VS Code 自己不强制 publisher 前缀（只要求全局唯一），所以正确的约束是：
**「必须形如 `<自己的 name>.<something>` 或 `<自己的 publisher>.<自己的 name>.<something>`」**
—— 既贴真实生态，又保住「不能声明别人的命令」。

### 3. `rainbow-csv` 的 24 条命令现在过了几条

**全过了**，逐条验过：

```
ok  ★ 24 条真实命令没有一条被前缀规则拒
ok  ★ 24 条逐条验，0 条被前缀规则拒（实际 0 条）
```

**但整包仍然装不进** —— 卡在 `main` 路径（`./extension` vs 要求的 `./extension.js`）。
那不在本卡范围（是清单层的另一道墙），本卡只负责前缀。

**其余两道已知的墙仍在**（不是本卡的事，但给盘点用）：
`extension.js` 24 KiB 限额（rainbow-csv 是 136 KB）、`require` 白名单只有 `"vscode"`。

### 4. 变异三条：预期 vs 实际

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 完全去掉前缀检查 | 红 1 条 | **红 5 条** |
| M2 只接受 `publisher.name.`（回到旧规则） | 红 3 条以上 | **红 6 条** |
| M3 允许裸命令 | 红 1 条 | **红 0 条** → 修变异后 **红 2 条**（见 §5） |

### 5. ⚠️ M3 第一版红 0 条 —— **变异本身没生效**

第一版我把 `namePrefix`（带点的 `"demo."`）改成 `pkg.name`（`"demo"`），
想模拟「允许裸命令」。但 `"hello".startsWith("demo")` 本来就是 **false** ——
**这个变异什么都没改变**，套件当然全绿。

**这不是断言弱，是变异没模拟 bug 的样子。**（CLAUDE.md 第八条那一族。）

改成**真正会放宽**的形态才对：

```ts
// 真正允许裸命令：不带点的 id 直接放过
if (usedPrefix === null && commandId.includes(".")) { throw ... }
```

改完红 2 条（裸命令负控 + 错误信息那条）。

**教训**：变异脚本里第一步该问的是「我这个改动**真的**让它变坏了吗」，
不是「我改了一个看起来相关的字符」。

### 6. `commandId` 取值有没有出歧义 —— **没有**

- `this.commandId` 仍然取自 `pkg.contributes.commands[0].command`（`:481` 附近，未变）；
- 前缀放宽**只影响「哪些 id 被接受」**，不改变「取哪一条」——
  仍然是 `[0]`，仍然只激活第一条；
- 实测本机 24 个扩展中**没有** `publisher === name` 的，两种前缀不会对同一个 id 产生两种解读。

**所以：没有歧义，也没有顺手扩成多命令。** 多命令仍是 F007。

### 7. 新增了一条校验：清单内命令 id 唯一

卡里验收判据第 5 条要求的。原来**没有**这条校验（`grep` 只有 ZIP 条目的 `Duplicate VSIX entry`）。

加了 `refine`：`new Set(list.map(c => c.command)).size === list.length`，
错误信息 `VSIX declares duplicate command ids`。

**为什么现在更需要它**：前缀放宽之后，两份清单可以用同一个 `name` 段，
重复 id 会让「哪条命令被调用」变得不确定。

### 8. 提交

`26907b71`（4 文件，+299/−3）。`tsc` exit 0，三条变异全部红在正确位置，
还原逐字节 `SAME (f38e377e...)`。

**相关套件全绿**：`vsix-command-prefix-smoke 14/14`、`vsix-manifest-schema-smoke 17/17`、
`vsix-deflate-smoke 24/24`、`vsix-size-limits-smoke 21/21`、`vscode-l1-smoke 27/27`。

### 9. 觉得不对但没改的

1. **`main` 路径 `./extension` vs `./extension.js`** 现在是**最后一道清单层的墙**。
   VS Code 会给没有后缀的 main 补 `.js`，我们不补。rainbow-csv 就卡在这。
   **它比前缀更影响面广**（前缀影响所有扩展，main 影响所有用无后缀写法的扩展）——
   建议优先级排在本卡之后、F007 之前。
2. **`publisher` 正则 `^[a-z][a-z0-9-]{1,30}$` 会拒 `James-Yu`**（大写 J）。
   本卡没动它：测试里我把 `James-Yu` 降成了 `james-yu` 只用它的 name 段验前缀。
   **但真实扩展里确实有大写 publisher**，这是又一道墙，值得单开。
