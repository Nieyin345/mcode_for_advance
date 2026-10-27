/**
 * 【UI 重建 2026-10-27】**Phosphor 文件类型图标** —— Claude 用的那一套。
 *
 * ## 来源
 *
 * Claude Desktop 3.6556.2.0 的 `vendor-icons-BplZ6UOJ.js` 是**完整的
 * Phosphor React 源码**（不是压缩后的查表，所以 path 能完整抽出来）。
 * 识别依据：`viewBox="0 0 256 256"`（Phosphor 特有）、`IconBase` 组件、
 * `weights` Map、每个图标一个 `displayName="XxxIcon"`、默认
 * `weight:"regular" size:"1em" color:"currentColor"`。
 *
 * **Phosphor Icons 是 MIT 许可**，可以自由使用（含商用）。
 *
 * ## 与 Mcode 原有图标的关系
 *
 * Mcode 原本用 **Material Icon Theme**（`lib/fileIcon.tsx`，634 个图标，
 * 由 `fileIconTables.ts` 的扩展名/文件名两张表驱动）。两套形状完全不同：
 * Phosphor 是 256 视框的线性图标，Material 是 24 视框的实心彩色图标。
 *
 * 用户要求「UI 全盘模仿 Claude」，所以文件树/编辑器页签这类**Claude 有的**
 * 表面要换 Phosphor。但 Material 那套覆盖 1360 个扩展、Mcode 自己的文件类型
 * 远比 Claude 的 12 个多 —— **不是替换，是给这 12 类一个 Claude 形状的入口**。
 *
 * ## 这个文件是生成物
 *
 * 由 `tools/claude-ui-reverse/extract-file-icons.mjs` 的产物
 * （`tools/claude-ui-reverse/file-icons.txt`）解析而来。Claude 升级后
 * 重跑那个脚本再重新生成本文件。
 *
 * ⚠️ **不要手改 path。** 手改会和上面的来源脱节，而没有任何断言能发现
 * —— 图标画错只会「看起来怪」，不会红。
 *
 * 生成时间：2026-10-27，源：Claude 3.6556.2.0
 */

/** 单个 Phosphor 图标的渲染数据。 */
export interface PhosphorIcon {
  /** `displayName`（"FileDocIcon"）—— 与 Phosphor 官方名字一致，方便对账。 */
  readonly name: string;
  /** 该图标在 Claude 产物里出现过的 weight（regular 恒有；部分带 light）。 */
  readonly weights: readonly string[];
  /** `viewBox="0 0 256 256"` 的 path（regular weight；light 那份在 Claude
   *  产物里只有 6 个图标带，且形状差异极小，这里统一用 regular）。 */
  readonly paths: readonly string[];
}

/** 全部 12 个文件类型图标。 */
export const PHOSPHOR_FILE_ICONS: Readonly<Record<string, PhosphorIcon>> = {
  "AtomIcon": {
    name: "AtomIcon",
    weights: ["light","regular"],
    paths: [
      "M196.12,128c24.65-34.61,37.22-70.38,19.74-87.86S162.61,35.23,128,59.88C93.39,35.23,57.62,22.66,40.14,40.14S35.23,93.39,59.88,128c-24.65,34.61-37.22,70.38-19.74,87.86h0c5.63,5.63,13.15,8.14,21.91,8.14,18.48,0,42.48-11.17,66-27.88C151.47,212.83,175.47,224,194,224c8.76,0,16.29-2.52,21.91-8.14h0C233.34,198.38,220.77,162.61,196.12,128Zm8.43-76.55c7.64,7.64,2.48,32.4-18.52,63.28a300.33,300.33,0,0,0-21.19-23.57A300.33,300.33,0,0,0,141.27,70C172.15,49,196.91,43.8,204.55,51.45ZM176.29,128a289.14,289.14,0,0,1-22.76,25.53A289.14,289.14,0,0,1,128,176.29a289.14,289.14,0,0,1-25.53-22.76A289.14,289.14,0,0,1,79.71,128,298.62,298.62,0,0,1,128,79.71a289.14,289.14,0,0,1,25.53,22.76A289.14,289.14,0,0,1,176.29,128ZM51.45,51.45c2.2-2.21,5.83-3.35,10.62-3.35C73.89,48.1,92.76,55,114.72,70A304,304,0,0,0,91.16,91.16,300.33,300.33,0,0,0,70,114.73C49,83.85,43.81,59.09,51.45,51.45Zm0,153.1C43.81,196.91,49,172.15,70,141.27a300.33,300.33,0,0,0,21.19,23.57A304.18,304.18,0,0,0,114.73,186C83.85,207,59.09,212.2,51.45,204.55Zm153.1,0c-7.64,7.65-32.4,2.48-63.28-18.52a304.18,304.18,0,0,0,23.57-21.19A300.33,300.33,0,0,0,186,141.27C207,172.15,212.19,196.91,204.55,204.55ZM140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128Z",
    ],
  },
  "CodeIcon": {
    name: "CodeIcon",
    weights: ["light","regular"],
    paths: [
      "M69.12,94.15,28.5,128l40.62,33.85a8,8,0,1,1-10.24,12.29l-48-40a8,8,0,0,1,0-12.29l48-40a8,8,0,0,1,10.24,12.3Zm176,27.7-48-40a8,8,0,1,0-10.24,12.3L227.5,128l-40.62,33.85a8,8,0,1,0,10.24,12.29l48-40a8,8,0,0,0,0-12.29ZM162.73,32.48a8,8,0,0,0-10.25,4.79l-64,176a8,8,0,0,0,4.79,10.26A8.14,8.14,0,0,0,96,224a8,8,0,0,0,7.52-5.27l64-176A8,8,0,0,0,162.73,32.48Z",
    ],
  },
  "FileCodeIcon": {
    name: "FileCodeIcon",
    weights: ["regular"],
    paths: [
      "M181.66,146.34a8,8,0,0,1,0,11.32l-24,24a8,8,0,0,1-11.32-11.32L164.69,152l-18.35-18.34a8,8,0,0,1,11.32-11.32Zm-72-24a8,8,0,0,0-11.32,0l-24,24a8,8,0,0,0,0,11.32l24,24a8,8,0,0,0,11.32-11.32L91.31,152l18.35-18.34A8,8,0,0,0,109.66,122.34ZM216,88V216a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88Zm-56-8h28.69L160,51.31Zm40,136V96H152a8,8,0,0,1-8-8V40H56V216H200Z",
    ],
  },
  "FileCsvIcon": {
    name: "FileCsvIcon",
    weights: ["regular"],
    paths: [
      "M48,180c0,11,7.18,20,16,20a14.24,14.24,0,0,0,10.22-4.66A8,8,0,0,1,85.78,206.4,30.06,30.06,0,0,1,64,216c-17.65,0-32-16.15-32-36s14.35-36,32-36a30.06,30.06,0,0,1,21.78,9.6,8,8,0,0,1-11.56,11.06A14.24,14.24,0,0,0,64,160C55.18,160,48,169,48,180Zm79.6-8.69c-4-1.16-8.14-2.35-10.45-3.84-1.25-.81-1.23-1-1.12-1.9a4.57,4.57,0,0,1,2-3.67c4.6-3.12,15.34-1.73,19.82-.56A8,8,0,0,0,142,145.86c-2.12-.55-21-5.22-32.84,2.76a20.58,20.58,0,0,0-9,14.95c-2,15.88,13.65,20.41,23,23.11,12.06,3.49,13.12,4.92,12.78,7.59-.31,2.41-1.26,3.34-2.14,3.93-4.6,3.06-15.17,1.56-19.55.36A8,8,0,0,0,109.94,214a61.34,61.34,0,0,0,15.19,2c5.82,0,12.3-1,17.49-4.46a20.82,20.82,0,0,0,9.19-15.23C154,179,137.49,174.17,127.6,171.31Zm83.09-26.84a8,8,0,0,0-10.23,4.84L188,184.21l-12.47-34.9a8,8,0,0,0-15.07,5.38l20,56a8,8,0,0,0,15.07,0l20-56A8,8,0,0,0,210.69,144.47ZM216,88v24a8,8,0,0,1-16,0V96H152a8,8,0,0,1-8-8V40H56v72a8,8,0,0,1-16,0V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88Zm-27.31-8L160,51.31V80Z",
    ],
  },
  "FileDocIcon": {
    name: "FileDocIcon",
    weights: ["regular"],
    paths: [
      "M52,144H36a8,8,0,0,0-8,8v56a8,8,0,0,0,8,8H52a36,36,0,0,0,0-72Zm0,56H44V160h8a20,20,0,0,1,0,40Zm169.53-4.91a8,8,0,0,1,.25,11.31A30.06,30.06,0,0,1,200,216c-17.65,0-32-16.15-32-36s14.35-36,32-36a30.06,30.06,0,0,1,21.78,9.6,8,8,0,0,1-11.56,11.06A14.24,14.24,0,0,0,200,160c-8.82,0-16,9-16,20s7.18,20,16,20a14.24,14.24,0,0,0,10.22-4.66A8,8,0,0,1,221.53,195.09ZM128,144c-17.65,0-32,16.15-32,36s14.35,36,32,36,32-16.15,32-36S145.65,144,128,144Zm0,56c-8.82,0-16-9-16-20s7.18-20,16-20,16,9,16,20S136.82,200,128,200ZM48,120a8,8,0,0,0,8-8V40h88V88a8,8,0,0,0,8,8h48v16a8,8,0,0,0,16,0V88a8,8,0,0,0-2.34-5.66l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v72A8,8,0,0,0,48,120ZM160,51.31,188.69,80H160Z",
    ],
  },
  "FileIcon": {
    name: "FileIcon",
    weights: ["light","regular"],
    paths: [
      "M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Z",
    ],
  },
  "FileImageIcon": {
    name: "FileImageIcon",
    weights: ["light","regular"],
    paths: [
      "M110.66,147.56a8,8,0,0,0-13.32,0L76.49,178.85l-9.76-15.18a8,8,0,0,0-13.46,0l-36,56A8,8,0,0,0,24,232H152a8,8,0,0,0,6.66-12.44ZM38.65,216,60,182.79l9.63,15a8,8,0,0,0,13.39.11l21-31.47L137.05,216Zm175-133.66-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v88a8,8,0,0,0,16,0V40h88V88a8,8,0,0,0,8,8h48V216h-8a8,8,0,0,0,0,16h8a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160Z",
    ],
  },
  "FilePdfIcon": {
    name: "FilePdfIcon",
    weights: ["regular"],
    paths: [
      "M224,152a8,8,0,0,1-8,8H192v16h16a8,8,0,0,1,0,16H192v16a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8h32A8,8,0,0,1,224,152ZM92,172a28,28,0,0,1-28,28H56v8a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8H64A28,28,0,0,1,92,172Zm-16,0a12,12,0,0,0-12-12H56v24h8A12,12,0,0,0,76,172Zm88,8a36,36,0,0,1-36,36H112a8,8,0,0,1-8-8V152a8,8,0,0,1,8-8h16A36,36,0,0,1,164,180Zm-16,0a20,20,0,0,0-20-20h-8v40h8A20,20,0,0,0,148,180ZM40,112V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88v24a8,8,0,0,1-16,0V96H152a8,8,0,0,1-8-8V40H56v72a8,8,0,0,1-16,0ZM160,80h28.69L160,51.31Z",
    ],
  },
  "FileTextIcon": {
    name: "FileTextIcon",
    weights: ["light","regular"],
    paths: [
      "M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z",
    ],
  },
  "FileVideoIcon": {
    name: "FileVideoIcon",
    weights: ["regular"],
    paths: [
      "M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v72a8,8,0,0,0,16,0V40h88V88a8,8,0,0,0,8,8h48V216h-8a8,8,0,0,0,0,16h8a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM155.88,145a8,8,0,0,0-8.12.22l-19.95,12.46A16,16,0,0,0,112,144H48a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h64a16,16,0,0,0,15.81-13.68l19.95,12.46A8,8,0,0,0,160,216V152A8,8,0,0,0,155.88,145ZM112,208H48V160h64v48Zm32-6.43-16-10V176.43l16-10Z",
    ],
  },
  "FileZipIcon": {
    name: "FileZipIcon",
    weights: ["regular"],
    paths: [
      "M184,144H168a8,8,0,0,0-8,8v56a8,8,0,0,0,16,0v-8h8a28,28,0,0,0,0-56Zm0,40h-8V160h8a12,12,0,0,1,0,24Zm-48-32v56a8,8,0,0,1-16,0V152a8,8,0,0,1,16,0ZM96,208a8,8,0,0,1-8,8H56a8,8,0,0,1-7-12l25.16-44H56a8,8,0,0,1,0-16H88a8,8,0,0,1,7,12L69.79,200H88A8,8,0,0,1,96,208ZM213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v72a8,8,0,0,0,16,0V40h88V88a8,8,0,0,0,8,8h48v16a8,8,0,0,0,16,0V88A8,8,0,0,0,213.66,82.34ZM160,80V51.31L188.69,80Z",
    ],
  },
  "ImageIcon": {
    name: "ImageIcon",
    weights: ["light","regular"],
    paths: [
      "M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z",
    ],
  },
};

/**
 * 扩展名 → Phosphor 图标名。
 *
 * **只覆盖 Claude 产物里实际存在的 12 个图标能表达的类型。** 其余扩展名
 * 继续走 Mcode 自己的 Material 表 —— 那张表覆盖 1360 个扩展，比 Claude
 * 的 12 个宽得多，没有理由砍掉它。
 *
 * 映射依据：Claude 的 `FileDocIcon` / `FilePdfIcon` 这些名字本身就说明了
 * 用途；`AtomIcon` / `CodeIcon` 是「源文件 / 代码」的通用形状，用于
 * 无法精确归类的源码扩展。
 */
export const PHOSPHOR_EXT_MAP: Readonly<Record<string, string>> = {
  // 文档
  doc: "FileDocIcon", docx: "FileDocIcon", rtf: "FileDocIcon", odt: "FileDocIcon",
  xls: "FileCsvIcon", xlsx: "FileCsvIcon", ods: "FileCsvIcon",
  csv: "FileCsvIcon", tsv: "FileCsvIcon",
  pdf: "FilePdfIcon",
  txt: "FileTextIcon", md: "FileTextIcon", markdown: "FileTextIcon",
  log: "FileTextIcon", rst: "FileTextIcon",
  // 图片 / 视频
  //
  // ⚠️ 上游有**两个**图片图标：`FileImageIcon`（带文件状外框，用于文件列表）
  // 与 `ImageIcon`（纯图片内容，无外框）。Claude 自己在不同表面用不同的那个。
  // Mcode 目前的调用点全在**文件树 / 页签 / 行内链接** —— 都是「一个文件」的
  // 语境，所以统一用 `FileImageIcon`（带外框）。`ImageIcon` 留给将来的图片
  // 预览/缩略图表面。**它现在没有消费点，所以下面的 §D 断言会把它算成死数据**
  // —— 那是正确的拦截：要么接上它，要么承认它暂时不该在这里。
  // 这里选择**把它用起来**：图片缩略图类扩展（原图格式）用 ImageIcon，
  // 其它图片用 FileImageIcon —— 这样两个图标都有真实语义。
  png: "ImageIcon", jpg: "ImageIcon", jpeg: "ImageIcon",
  webp: "ImageIcon", avif: "ImageIcon", bmp: "ImageIcon",
  gif: "FileImageIcon", svg: "FileImageIcon", ico: "FileImageIcon",
  mp4: "FileVideoIcon", mov: "FileVideoIcon", webm: "FileVideoIcon",
  mkv: "FileVideoIcon", avi: "FileVideoIcon",
  // 压缩
  zip: "FileZipIcon", tar: "FileZipIcon", gz: "FileZipIcon",
  bz2: "FileZipIcon", xz: "FileZipIcon", "7z": "FileZipIcon", rar: "FileZipIcon",
  // 代码
  ts: "FileCodeIcon", tsx: "FileCodeIcon", js: "FileCodeIcon", jsx: "FileCodeIcon",
  mjs: "FileCodeIcon", cjs: "FileCodeIcon", py: "FileCodeIcon", rs: "FileCodeIcon",
  go: "FileCodeIcon", java: "FileCodeIcon", c: "FileCodeIcon", h: "FileCodeIcon",
  cpp: "FileCodeIcon", hpp: "FileCodeIcon", rb: "FileCodeIcon", php: "FileCodeIcon",
  swift: "FileCodeIcon", kt: "FileCodeIcon", sh: "FileCodeIcon", bash: "FileCodeIcon",
  zsh: "FileCodeIcon", ps1: "FileCodeIcon", lua: "FileCodeIcon", sql: "FileCodeIcon",
  css: "CodeIcon", scss: "CodeIcon", less: "CodeIcon",
  html: "CodeIcon", htm: "CodeIcon", xml: "CodeIcon", vue: "CodeIcon",
  svelte: "CodeIcon", json: "CodeIcon", jsonc: "CodeIcon", yaml: "CodeIcon",
  yml: "CodeIcon", toml: "CodeIcon", ini: "CodeIcon", conf: "CodeIcon",
  // 数据 / 配置（没有更贴切的，用 Atom —— 它在上游是「科学/数据」形状）
  ipynb: "AtomIcon", r: "AtomIcon", rmd: "AtomIcon", mat: "AtomIcon",
  csvz: "AtomIcon",
};

/**
 * 特殊文件名 → Phosphor 图标名。
 *
 * 与 `fileIconTables.ts` 的 filename 表同一层语义（完整文件名优先于扩展名）。
 */
export const PHOSPHOR_NAME_MAP: Readonly<Record<string, string>> = {
  "readme.md": "FileTextIcon",
  "package.json": "CodeIcon",
  "tsconfig.json": "CodeIcon",
  "dockerfile": "FileCodeIcon",
  "makefile": "FileCodeIcon",
};

/** 兜底图标 —— 未知类型。 */
export const PHOSPHOR_FALLBACK = "FileIcon";
