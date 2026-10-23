# T90｜🔴 P0：中文用户名下「换数据目录 / 数据迁移」会让应用无声崩溃

- Status: **ready-for-human**（涉及用户数据，修法需要决定）
- Category: **P0 产品缺陷**
- Priority: **P0 —— 用户丢数据 / 应用无声消失，触发条件是国内主流配置**
- Depends on: T89（`c25bf54a`，根因定位）
- Exclusive writable files: `apps/desktop/src/main/lib/dataRoot.ts`（+ 新建套件）

## Required Skills
- `diagnosing-bugs`：确认触发条件与边界。
- `mcode-smoke`：补回归。

## 背景：两个 `cpSync` 在 `try/catch` 里，但 native crash 接不住

`apps/desktop/src/main/lib/dataRoot.ts` 有两处：

| 行 | 场景 |
|---|---|
| **`:150`** | `moveIfNeeded`：**rename 失败后的 fallback**（目录被资源管理器锁住时 EPERM） |
| **`:198`** | 用户在设置里**选择新数据目录**时的复制 |

**两处都包在 `try/catch` 里，但 `fs.cpSync` 的崩溃是 native fast-fail —— `catch` 根本不会执行，进程直接死。**

### 触发条件（B 的 2×2 矩阵，总控核实）

| 条件 | 路径长 | 结果 |
|---|---|---|
| 短 + 英文 | 53 | ✅ OK |
| **短 + 中文** | **48** | ❌ **`0xC0000005` 崩** |
| **长 + 英文** | **132** | ✅ **OK** |
| 长 + 中文 | 108 | ❌ 崩 |

**132 字符的纯英文路径完全正常；48 字符的中文路径直接崩。**

**→ 变量是「非 ASCII」，不是「长度」。**

### 影响面

**这台机器**：`C:\Users\Nieyin\AppData\Roaming\Mcode` —— 37 字符，纯 ASCII，**安全**。

**但用户名是变量**：

| 用户名 | 路径长 | 结果 |
|---|---|---|
| `Alice` | 77 | ✅ OK |
| **`张伟`** | **74** | ❌ **`0xC0000409` 崩** |
| `张伟` + 长产品名 | 94 | ❌ 崩 |

**`C:\Users\张伟\` 在国内是主流配置。**

### 用户看到什么

**没有任何错误提示** —— 进程已经没了。

- 启动时：**应用无声消失**；
- 换数据目录时：**整个应用崩溃**，而且**数据处于「复制了一半」的状态**。

### 跨版本

| Node | 结果 |
|---|---|
| **v22.21.1** | 崩 |
| v22.14.0 | OK |
| v20.18.0 | OK |

**是 22.21.1 的回归。**

## ✅ 方案已定：`filter: () => true`（B 找到上游 issue，总控独立验证）

### 上游已确认（不是猜测）

| Issue | 内容 |
|---|---|
| **nodejs/node#54476**（2024-08 起） | `fs.cpSync` 在含中文的目录上崩溃，**"How often does it reproduce? — always"** |
| **nodejs/node#59636** | Node 自己的 CI：`parallel/test-fs-cp-sync-unicode-folder-names`，**`exitcode: 3221226505`** —— 和我们测到的一模一样 |
| **nodejs/node#63970** | `cpSync` 不带 `filter` 时走 **native copyDir fast path**；**传 `filter` 会回退到 JS 实现**，不受影响 |

### 总控独立验证（三种形态，同一份夹具）

```
plain    status=3221226505  崩溃
filter   status=0           OK — 文件真的复制了（OK:hello）
force    status=3221226505  崩溃（force 不绕过）
```

### 修法

```ts
cpSync(from, to, { recursive: true, filter: () => true });
```

**注释写法**（B 的判断，总控认可）：

```ts
// Node 22 on Windows crashes in cpSync's native fast path when the path has
// non-ASCII characters (nodejs/node#54476, #63970). Passing any filter forces
// the JS implementation, which is unaffected.
```

**⚠️ 写 issue 编号，不要写「这个仓库不能用 `cpSync`」**：
- **前者**：随 Node 修复而"不再需要"，但**不会误导**（读到的人会去查 issue）；
- **后者**：**永远误导**（让人以为这是仓库的永久约束）。

### 影响面比「中文用户」大

B 实测：中文 `中文`、Latin-1 `café` / `Müller`、西里尔 `Тест`、emoji `😀x`、全角 `Ａ` —— **全部崩**。

**所以是「所有非 ASCII 用户名 / 路径的用户」**，不只是中文。

Mcode 的产品定位是「技术型个人用户与小团队」——**这个范围里德国、俄罗斯、日本用户都可能出现。**

## ⚠️ 还剩一件事：性能要量

`filter: () => true` **强制走 JS 实现，会比 native fast path 慢**。

- 对**许可证 materials**（17 个文件）**无所谓**；
- 对 **`dataRoot` 的用户数据**（可能几百 MB）**要量**。

**做法**：找一个 ~200 MB 的目录，对比 `cpSync` 有无 `filter` 的耗时。

**如果慢得可接受（比如 < 2 倍）→ 直接用。**
**如果慢很多 → 只在非 ASCII 时加 `filter`**：

```ts
const needsJs = /[^\x00-\x7F]/.test(from) || /[^\x00-\x7F]/.test(to);
cpSync(from, to, { recursive: true, ...(needsJs ? { filter: () => true } : {}) });
```

## 必须回答的三个问题## 必须回答的三个问题

1. ✅ **上游修了吗？** —— 没修。`#54476` 从 2024-08 开着，`#59636` 是 2025-08 的 CI 记录。
2. ✅ **是哪个版本？** —— 22.6.0 起（`#53614` 引入 native 编码回归），22.14.0 / 20.18.0 正常。
3. ✅ **选哪个方案？** —— `filter: () => true`（方案 4），已由上游 issue 和总控实验双重确认。
4. ⏳ **性能代价多少？** —— **这一条还没答，动手前必须量。**

## 修之前必须先补的回归

**在此之前没有任何套件覆盖这两个 `cpSync` 分支**（`dataRoot.ts` 的两处失败路径）。

**补回归的难点**：`cpSync` 崩溃会让**测试进程本身**死，**不能用普通断言测**。

**做法**：用 `spawnSync` 起一个子进程跑「含中文路径的 `cpSync`」，断言它的 `status`：

```ts
// 子进程里跑 cpSync，父进程看 status
const r = spawnSync(process.execPath, [probeScript, chinesePath], { });
check("★ 非 ASCII 路径下复制不崩（或已降级）",
  r.status === 0, { status: r.status });
```

**这条断言本身就证明了「修好之后不再崩」**，而且它能在崩溃发生时存活（因为在父进程里）。

## 验收判据

1. **三个问题都有答案**（上游修没修、哪个版本、选哪个方案）。
2. **有一个回归**，用 `spawnSync` 在子进程里验（父进程不受崩溃影响）。
3. **变异**：把降级去掉 → 回归必须红（子进程 `status !== 0`）。
4. **ASCII 路径仍然正常**（不能为了修中文而破坏英文）。
5. 不跑全量、不起 Electron。

## 边界

- **先决定方案，再动 `dataRoot.ts`**；
- **不要在这张卡里改 `build/stage-*.cjs`**（打包脚本，另算）；
- 不碰 T89 的两个套件（它们是 P0 的**报警器**，修了报警器就没人知道火还在烧）。

## 回写

`tasks/T90-cpsync-non-ascii-p0.md` 末尾追加 `## 结果回写`：
三个问题的答案、选定方案、回归实现与变异、`dataRoot` 改动 diff。
