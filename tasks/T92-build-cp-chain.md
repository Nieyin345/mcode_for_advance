# T92｜打包链在这台机器上跑不完（7 处 `cpSync`）

- Status: **ready-for-agent**
- Category: **构建基础设施**（不是用户数据，但让发版做不了）
- Priority: **P1 —— 打包坏了不会丢数据，但它让「发版」在这台机器上做不了**
- Depends on: T89（`741e4b1d`）、T90（`5f954755`，同根因）
- Exclusive writable files:
  - `apps/desktop/build/stage-genoffice-resources.cjs`
  - `apps/desktop/build/stage-node-red-resources.cjs`
  - `apps/desktop/build/dereference-workspace-symlinks.cjs`
  - `apps/desktop/electron.vite.config.ts`
  - 新建 `apps/desktop/scripts/t92-build-cp-smoke/`

## Required Skills
- `mcode-smoke`：子进程回归。
- 无 Electron 需求。

## 背景：打包**确实**崩了（总控严格测过）

```bash
$ node apps/desktop/build/stage-node-red-resources.cjs > /tmp/o 2>/tmp/e
$ echo $?
127        ← 真实退出码
```

（第一次测时用了 `| tail -5; echo $?`，拿到的是 `tail` 的——**所以它可能已经坏了好几天而没人发现**。）

## 七处 `cpSync`

| 文件 | 行 | 用途 |
|---|---|---|
| `stage-genoffice-resources.cjs` | `:681` | CLI `node_modules` |
| `stage-genoffice-resources.cjs` | `:692` | renderer |
| `stage-genoffice-resources.cjs` | `:695` | preload |
| `stage-node-red-resources.cjs` | `:683` | production `node_modules` |
| `stage-node-red-resources.cjs` | `:687` | packages |
| `stage-node-red-resources.cjs` | `:698` | license materials |
| `dereference-workspace-symlinks.cjs` | `:70` | symlink 复制 |
| `electron.vite.config.ts` | `:165`、`:188` | 构建期资源 |

**这些的源路径都在 `D:\副桌面\文件夹\...` 下 —— 必然含非 ASCII。**

## 任务

### 第一步：先确认每一处的源和目标

**不是所有 `cpSync` 都会崩**（T90 发现：源含非 ASCII → 崩；目标含非 ASCII → 静默不复制）。

**逐处判断**：

```bash
# 对每一处，找出它的 src 和 dst 变量从哪来
sed -n '<行号-3>,<行号+3>p' <文件>
```

**产出**：一张表（文件 / 行 / src 来源 / dst 来源 / 会不会崩）。

### 第二步：修

**统一加 `filter: () => true`**：

```js
fs.cpSync(src, dst, { recursive: true, filter: () => true });
```

**注意 `dereference` 要和 `filter` 同时传**（两者不冲突，已由总控验证）：

```js
fs.cpSync(src, dst, { recursive: true, dereference: true, filter: () => true });
```

**注释按 T90 的写法**（条件 + 出处 + 后果，不写方案）。

### 第三步：验证打包真的能跑完

**这是本卡的核心。**

```bash
node apps/desktop/build/stage-node-red-resources.cjs > /tmp/o 2>/tmp/e
echo "EXIT=$?"        # 必须是 0，不是 127
```

**每一处都跑一遍**：

```bash
node apps/desktop/build/stage-genoffice-resources.cjs > /tmp/o1 2>/tmp/e1; echo $?
node apps/desktop/build/dereference-workspace-symlinks.cjs > /tmp/o2 2>/tmp/e2; echo $?
```

### 第四步：新套件

`apps/desktop/scripts/t92-build-cp-smoke/`：

- **用 `spawnSync` 跑每个 stage 脚本**，断言 `status === 0`；
- **对照**：故意传一个不存在的源 → 必须是非 0 但**不是崩溃**（证明脚本真的在跑）。

**这个套件的意义**：**它会在下次有人改打包脚本时红**，而不是等到发版才发现。

⚠️ **注意**：stage 脚本可能很慢（要 `npm install`）。**如果超过 2 分钟，考虑只测「`cpSync` 那一段」而不是整个脚本** —— 你判断。

## 验收判据

1. **七处逐条判断表**（src/dst 来源、会不会崩）。
2. **每个 stage 脚本 `EXIT=0`**（严格测法，不用 `| tail`）。
3. **新套件**，且有对照。
4. **变异**：撤掉某一处的 `filter` → 对应脚本崩 → 还原。
5. 不跑全量、不起 Electron。

## 边界

- 只改上列四个文件 + 新建套件；
- **不改 `src/main/` 下任何文件**（那是 T90/T91/T93）；
- 不改 `package.json`。

## 遇到问题先检索

`electron.vite.config.ts:165,188` 在构建期跑，**可能是 vite 插件的形式** —— 先读代码，不要直接改。

## 回写

`tasks/T92-build-cp-chain.md` 末尾追加 `## 结果回写（2026-10-24）`：
七处判断表、每个脚本的 `EXIT`、新套件结果、变异、提交 SHA。
