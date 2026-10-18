/** 为「自动化」面板生成**真实**节点类型目录(与 workflow-ui-smoke/metadata.ts 同一手法:
 *  只用主进程的内置清单,不碰数据根/插件目录 —— 那两个模块在 build 时换桩)。 */
import { writeFileSync } from "node:fs";
import { builtinManifestById } from "@main/orchestration/nodeTypes.js";
import type { NodeTypeCatalog } from "@contracts/nodeType";

const ids = ["mcode.main", "mcode.agent", "mcode.trigger", "mcode.command", "mcode.conversation"];
const catalog: NodeTypeCatalog = {
  entries: ids.map((id) => {
    const manifest = builtinManifestById(id);
    if (!manifest) throw new Error("Missing builtin: " + id);
    return { id, source: "builtin", from: "MCode", manifest };
  }),
  problems: [],
};
writeFileSync(process.argv[2], JSON.stringify(catalog, null, 2));
console.log("catalog: " + catalog.entries.map((e) => e.id).join(","));
