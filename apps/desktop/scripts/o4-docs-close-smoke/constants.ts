/**
 * O4 —— 旅程与装配共用的**纯常量/纯函数**（顶层不 import electron / vendor）。
 *
 * 这个文件存在的理由：`setup.ts` 顶层 `require("genoffice:docx-engine")`（夹具用），
 * 而旅程注册表在**普通 Node**（`build.mjs`）里也会被加载 —— 旅程模块必须惰性加载，
 * 但旅程文件仍要能拿到唯一文本与页面 URL，所以把它们放在这个零依赖的叶子里。
 */
import { join } from "node:path";

/** 夹具里的唯一文本（DOM 断言用；与其它套件的 token 区分开）。 */
export const O4_UNIQUE = "O4-DOCS-CLOSE-3f9a";

/** docs 页地址：生产面板同一份（`file://…/apps/docs/out/renderer/index.html?mode=tab`）。 */
export function docsPageUrl(): string {
  const repoRoot = process.env.MCODE_U1_REPO;
  if (!repoRoot) throw new Error("O4: MCODE_U1_REPO 未设置");
  const page = join(repoRoot, "genoffice", "apps", "docs", "out", "renderer", "index.html");
  const normalized = page.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((part, index) => (index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join("/");
  const withScheme = /^[A-Za-z]:\//.test(normalized) ? `file:///${encoded}` : `file://${encoded}`;
  return `${withScheme}?mode=tab`;
}

/** 生产 CLI 路径（`isApprovedDocumentViewOpen` 的 root 判据由它推出）。 */
export function genofficeCliPath(): string {
  const repoRoot = process.env.MCODE_U1_REPO;
  if (!repoRoot) throw new Error("O4: MCODE_U1_REPO 未设置");
  return join(repoRoot, "genoffice", "packages", "cli", "dist", "genoffice.cjs");
}
