# T19｜Node-RED 源码 vendor 第一步：正式落地 + 解析链路

| 项目 | 值 |
|---|---|
| 编号 | T19 |
| 类型 | ARC-006（T13 调查的**实施**第一刀） |
| 优先级 | 高 |
| 建议并发 | 只改 `workflowEngines/` 与打包配置，可与 T18 / T05b 并行 |
| 预计规模 | 中 |

---

## 这一刀切在哪

T13 已查明（`docs/planning/node-red-vendor-integration-map.md`）：

- Node-RED **5.0.8**，commit `935b8d3e12ec8be064f3a72ac6547131f778a7b1`，Apache-2.0
- `require("node-red")` 默认**找不到** vendor 源码，必须给子进程私有 `NODE_PATH`
- 构建只要 **21.87s 安装 + 2.17s 构建**，不做 webpack
- 现有 `registry.BOOTSTRAP` 的 Admin token + `POST /flows` owner handshake
  是**高价值安全资产**，vendor 后必须复用，不能开新端口绕过

**本卡不碰 UI、不删旧画布、不做 store adapter。** 只做：

1. 把 `node-red/` 正式 vendor 进来（固定 commit + `mcode/integration` 分支）
2. 让 `createEngineLaunchSpec` 能解析到 vendor，并保留 npm fallback
3. 打包配置把 vendor 产物放进 extraResources
4. 跑通「启动引擎 → 打开编辑器页面 → 确认是 5.0.8」

---

## 开工前必读

1. `docs/planning/node-red-vendor-integration-map.md` **全文** —— 这是 T13 的产出，
   里面有逐项证据、改动面估算、扩展点对照。**按它做，不要重新调查。**
2. `apps/desktop/src/main/workflowEngines/runtimeSupervisor.ts:730-800` ——
   `createEngineLaunchSpec`，要改的就是这里。
3. `apps/desktop/src/main/workflowEngines/registry.ts:83-254`（BOOTSTRAP）
   与 `:511-553`（launchSpec 的 npm 检查）。
4. `apps/desktop/electron-builder.yml:103-124` —— 现有 GenOffice resources 的做法，
   照抄。
5. `apps/desktop/electron.vite.config.ts:203-253` —— 打包主进程的部分。
6. `.gitignore:69-70` —— `/genoffice/` 的写法，`/node-red/` 照抄。

---

## 执行内容

### 1. Vendor 落地（照 GenOffice 模式）

```bash
git clone https://github.com/node-red/node-red.git node-red
cd node-red
git checkout -b mcode/integration 935b8d3e12ec8be064f3a72ac6547131f778a7b1
```

- `.gitignore` 加 `/node-red/`
- **不要**在 `node-red/` 里做任何改动（这一步只要一个干净的固定基线）
- 记录基线 SHA 到一个可查的文件（例如 `docs/planning/node-red-vendor-integration-map.md`
  已有，补一行「已 vendor」）

### 2. 构建产物

- 在 `node-red/` 里跑 `npm ci && npm run build`
- 确认 `packages/node_modules/@node-red/editor-client/public/red/red.min.js` 存在
- 产物要不要提交？**不要**。构建在打包阶段做（见第 4 步）。

### 3. 解析链路（核心）

改 `createEngineLaunchSpec` + `registry`：

- 新增一个**受控的** vendor 目录解析：
  - 优先 `<appPath>/../node-red`（开发）或 `process.resourcesPath/node-red`（打包）
  - 校验存在 `packages/node_modules/node-red/package.json` 且 `version === "5.0.8"`
  - 校验通过后，给子进程设 `NODE_PATH=<vendor>/packages/node_modules;<vendor>/node_modules`
- **保留 npm fallback**：vendor 缺失或校验失败 → 回退到现在的
  `<dataDir>/node_modules/node-red`，并**显式记录**走了 fallback。
- **不许**把 `dataDir` 下的第三方节点路径加进高优先级 `NODE_PATH`
  （那会让未审批的社区节点抢在官方包前面）。

### 4. 打包

- `electron-builder.yml` 的 `extraResources` 加 node-red 产物
- 新增一个 staging 脚本（照 GenOffice 的做法），把
  `node-red/packages/node_modules` + `node-red/node_modules`（**仅 production**）
  复制到 resources
- 加一个 afterPack 校验：产物存在、`red.min.js` 存在、版本对得上
- **不要把上游 CJS 打进主进程 bundle**（`electron.vite.config.ts` 应 0 行改动）

### 5. 「不改不重写」：确认现有安全资产还在

- `BOOTSTRAP` 的 `adminAuth` 与 `POST /flows` owner handshake **原样保留**
- vendor 后启动的引擎必须仍然：
  - 只监听 `127.0.0.1`
  - 要求 bearer token
  - 部署前经 owner 围栏

---

## 边界（不要碰）

- 不删 `WorkflowCanvas.tsx`（退场是后续阶段）
- 不做 storage adapter（那是 MERGE-1）
- 不做多项目 userDir 隔离（T13 说这条要 fork，不在本卡）
- 不改 renderer
- 不改 `genoffice/`
- 不改 `ModuleHost` / `permissionedProcessRunner`

---

## 验收判据

1. `node-red/` 存在、HEAD 是 `935b8d3`、`.gitignore` 已排除。
2. 开发模式下启动引擎，`createEngineLaunchSpec` 返回的 `NODE_PATH` 指向 vendor
   （有断言）。
3. vendor 缺失时回退到 npm 并记录（有断言）。
4. 引擎真的跑起来，编辑器页面能打开，**页面里报的版本是 5.0.8**
   （真 Electron 或 HTTP 抓取均可）。
5. 现有 `workflow-engine-runtime-smoke` / `node-red-e2e-smoke` /
   `mcode-node-pack-smoke` 全绿。
6. 双包 tsc 干净。
7. **变异验证**：把 vendor 路径改错 → 回退断言必红；把版本校验去掉 →
   版本断言必红。

---

## 回写区要回答

- vendor 目录多大？构建后多大？
- 解析走的是 vendor 还是 fallback？两种各验证了吗？
- 打包后的 resources 里有什么？
- 现有安全资产（adminAuth / owner handshake）确认还在吗？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
