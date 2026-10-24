/**
 * 为这套 smoke 生成**真节点类型目录** —— 与 `settings-form-lifecycle-smoke/metadata.ts`
 * 同一手法:只用主进程的内置清单(`builtinManifestById`),不碰数据根 / 插件目录
 * (那两个模块在 run.sh 的 esbuild 中用 `--alias` 换桩)。
 *
 * 为什么必须是真的清单:这套的判据之一是「点了节点之后右侧出现**那个节点的参数**」,
 * 而参数表单是**照清单生成的**(见 `NodeInspector` 文件头)。用一份手抄的 manifest
 * 去验,验的就不是生产里那张表 —— 而 T45 那轮夹具漂移的教训正是这个。
 */
import { writeFileSync } from "node:fs";
import { builtinManifestById } from "@main/orchestration/nodeTypes.js";
import type { NodeTypeCatalog } from "@contracts/nodeType";

// 覆盖本套件用到的三种:主代理(工作流入口)/ 子 agent(带 instruction 等参数)/
// 命令(参数形状完全不同的一档,用来证明切节点时表单**换掉**而不是叠加)。
const ids = ["mcode.main", "mcode.agent", "mcode.command"];
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
