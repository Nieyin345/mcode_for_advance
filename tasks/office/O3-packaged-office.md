# O3｜安装版里打开六格式：源码机能跑，不等于用户装完能跑

- Status: **ready-for-agent**
- Category: **Office / E2E-6**
- Priority: **P0 —— 这是「完全体」的最后一道门，而它一次都没验过**
- Depends on: 打包链路已通（`electron-builder --dir` EXIT=0，产物 875M，`resources/genoffice` 167M）
- 独占写入边界：
  - `apps/desktop/scripts/o3-packaged-u1/**`（新建）
  - **不得改** `apps/desktop/build/stage-genoffice-resources.cjs`（打包链路刚验过，见 `ec9ac3f2` / `fde19327`）
  - **不得触发新打包**（见第四节）

## Required Skills

- `mcode-smoke`：真 Electron 套件的写法
- `electron-u1` 相关：`apps/desktop/scripts/electron-u1/` 的 driver 骨架可直接复用

## 一、为什么这张卡最容易被跳过

`t7-genoffice-u1` 六格式全过，但它跑的是**源码树**：
- CLI 从 `genoffice/packages/cli/dist/genoffice.cjs` 加载
- renderer 从 `genoffice/apps/*/out/renderer` 加载
- sidecar 从 `genoffice/apps/sheets/native/xlsx-engine/target/release/` 加载

**安装版这三条路径全都变了**（见 `nativeViewsRoot()` 的两个分支）：

| | 源码 | 安装版 |
|---|---|---|
| CLI | `genoffice/packages/cli/dist/genoffice.cjs` | `resources/genoffice/cli/genoffice.cjs` |
| renderer | `genoffice/apps/<k>/out/renderer` | `resources/genoffice/apps/<k>/out/renderer` |
| sidecar | `.../target/release/xlsx-sidecar.exe` | `resources/genoffice/native/xlsx-sidecar.exe` |

**路径分支不同 = 可能只有一条被验过。** 这正是「源码能跑、装上不能跑」的经典来源。

## 二、判据

**用现成的 `apps/desktop/release/win-unpacked` 启动**（已在，875M，不要重新打包）。

### 2.1 启动即验的四件事

| # | 验什么 | 怎么验 |
|---|---|---|
| 1 | 进程起得来，主窗口可见 | 复用 `electron-u1` 的 CDP 连接 |
| 2 | `document.capabilities()` 报告的 `hosts` 六项为 true | **从应用内部读**，不是读文件 |
| 3 | `resources/genoffice/availability.json` 的 `editorsBundled === true` | 读产物文件 |
| 4 | `cliPath` 指向 **`resources/genoffice/cli/genoffice.cjs`**，不是源码路径 | 关键：证明走的是安装版分支 |

### 2.2 六格式逐一：打开（最低限度）

**本卡只要求「打开并渲染出真实内容」，不要求完整编辑保存**（那是 `t7` 在源码树上验的）。
理由：先证明资源路径在安装版下是对的，再谈编辑。两步分开，失败时能立刻定位是哪一类。

每格式：
- 打开一份真实样本；
- `assertDom` 找到该格式的特征元素
  （docs: `.ProseMirror`、sheets: `#univer-container canvas`、slides: 画布、pdf: PDF 页容器、
  markdown: 编辑区、html: 预览/源码区）；
- **不能只看「视图存在」** —— 必须看到该格式自己的特征 DOM。空壳页面也「存在」。

### 2.3 负控（必须有）

| 负控 | 期望 |
|---|---|
| 把 `resources/genoffice/apps/docs/out/renderer/index.html` 临时改名 | 打开 docs **应当失败并给出可执行说明**，不是白屏、不是假装成功 |
| 恢复后 | 再打开 docs 应当成功 |

**这个负控证明「打开成功」不是因为判据太松。**

## 三、★ 旧红 → 新绿

- 旧：六格式只在源码树验过，安装版零证据。
- 新：安装版启动 + capabilities 六项 + 六格式各自渲染出特征 DOM + 缺资源时正确拒绝。

**交付结论**：安装版能不能用 Office，卡在哪一步（如果卡）。

## 四、不要触发新打包

**用户明确说过「没做好之前不要打包」。** `release/win-unpacked` 已经存在（875M），直接用它。

如果你发现产物已损坏或缺失，**停下来回报**，不要自己跑 `electron-builder`。

## 五、本机限制（提前说明，不要当成缺陷）

- 打包产物是 **Windows x64**，只能在这台机器验。跨 OS（E2E-6 要求的「其它 OS」）**本卡不做**，
  交付时如实标注「仅 Windows 验过」。
- 真正「安装」（NSIS 安装器）**没做过**，`win-unpacked` 是解压态。
  本卡验的是「解压态能否运行」，不是「安装器能否正确安装」。**这两件事的差别要写进交付。**

## 六、变异要求

1. **删掉某个 `resources/genoffice/apps/<k>/out/renderer/index.html`** → 该格式打开必须失败；
2. **把 `availability.json` 的 `editorsBundled` 改成 false** → 第 2/3 条必须红；
3. 恢复后 `cmp` 逐字节核对。

## 七、结果回写区

（执行会话在此追加：启动结果、capabilities 六项、六格式 DOM 断言、负控、变异记录、提交 SHA）
